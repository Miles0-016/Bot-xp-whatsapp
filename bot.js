/**
 * bot.js - Bot WhatsApp XP avec Baileys (Traçabilité & Shield Anti-Crash)
 */

// =========================================================================
// 0. FIX CRITIQUE: POLYFILL CRYPTO POUR BAILEYS (Node.js < 19/20)
// =========================================================================
if (!globalThis.crypto) {
  globalThis.crypto = require('crypto').webcrypto || require('crypto');
}

const path = require('path');
const fs = require('fs');
const express = require('express');
const QRCode = require('qrcode');
const { Pool } = require('pg');
const pino = require('pino');

// Baileys
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
} = require('@whiskeysockets/baileys');

// =========================================================================
// 1. CONFIGURATION & LOGGER VERBOSE EXHAUSTIF
// =========================================================================
const logger = pino({
  // 'debug' par defaut comme demande (tres verbeux, y compris les logs
  // internes de Baileys). Repasser a 'info' ou 'warn' via LOG_LEVEL une fois
  // le diagnostic termine, pour ne pas saturer les logs Render en continu.
  level: process.env.LOG_LEVEL || 'debug',
  serializers: { err: pino.stdSerializers.err },
  transport: process.env.PRETTY_LOGS === 'false'
    ? undefined
    : { target: 'pino-pretty', options: { colorize: false, translateTime: 'SYS:standard' } },
});

const MAX_GROUPS = 5;
const XP_PER_MESSAGE = 1;
const MEDALS = ['🥇', '🥈', '🥉'];

const SUPER_ADMIN_NUMBERS = (process.env.SUPER_ADMIN_NUMBERS || '')
  .split(',')
  .map(n => n.trim())
  .filter(Boolean);
if (SUPER_ADMIN_NUMBERS.length === 0) logger.warn('⚠️ [CONFIG] SUPER_ADMIN_NUMBERS est vide');
else logger.info({ superAdmins: SUPER_ADMIN_NUMBERS }, 'ℹ️ [CONFIG] Super Admins chargés');

let currentQRCodeBase64 = null;
let BOT_NUMBER = null;
let keepAliveTimer = null;

// Anti-crash global
process.on('uncaughtException', err => logger.error({ err }, '💥 [CRITICAL] Uncaught Exception intercepté'));
process.on('unhandledRejection', reason => logger.error({ reason }, '💥 [CRITICAL] Unhandled Rejection intercepté'));

// =========================================================================
// 2. SERVEUR EXPRESS
// =========================================================================
const app = express();
const PORT = process.env.PORT || 8080;

app.get('/', (req, res) => {
  logger.info({ ip: req.ip, userAgent: req.headers['user-agent'] }, '🌐 [HTTP GET /] Consultation de la page d\'accueil');
  if (currentQRCodeBase64) {
    res.send(`
      <!DOCTYPE html>
      <html>
      <head><meta charset="UTF-8"><title>QR Code Bot XP</title>
      <style>body{background:#0f172a;color:#fff;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;font-family:sans-serif}.card{background:#1e293b;padding:2rem;border-radius:12px;text-align:center}.qr img{width:250px;border-radius:8px}</style>
      </head>
      <body><div class="card"><h2>📱 Scanne ce QR code</h2><div class="qr"><img src="${currentQRCodeBase64}"/></div><p>WhatsApp > Paramètres > Appareils liés</p></div></body>
      </html>
    `);
  } else {
    res.send('<html><body style="background:#0f172a;color:#4ade80;display:flex;justify-content:center;align-items:center;height:100vh;"><h2>✅ Bot en ligne</h2></body></html>');
  }
});

app.get('/health', (req, res) => {
  logger.info({ ip: req.ip }, '🔍 [HTTP GET /health] Check de santé demandé');
  res.status(200).json({
    status: 'ok',
    qrAvailable: currentQRCodeBase64 !== null,
    groupesActifs: cachedGroups?.size || 0,
    adminsBot: cachedAdmins?.size || 0,
    pendingXP: pendingXP?.size || 0,
    botNumber: BOT_NUMBER,
    dernierMessageRecuDepuis_ms: Date.now() - lastMessageEventAt,
    memory: process.memoryUsage(),
  });
});

app.listen(PORT, () => {
  logger.info(`🚀 [HTTP] Serveur Express démarré sur le port ${PORT}`);
});

// =========================================================================
// 3. BASE DE DONNÉES SUPABASE
// =========================================================================
logger.info('🐘 [DB] Connexion à la base de données Supabase...');
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 5,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30000,
      statement_timeout: 5000,
      query_timeout: 5000,
    })
  : null;

if (!pool) logger.error('❌ [DB] DATABASE_URL absente des variables d\'environnement');
else {
  logger.info('✅ [DB] Pool PostgreSQL configuré avec succès');
  pool.on('error', err => logger.error({ err }, '💥 [DB POOL ERROR] Erreur inattendue sur le client PostgreSQL'));
}

function queryWithTimeout(text, params) {
  if (!pool) return Promise.reject(new Error('Pool PostgreSQL non initialisé'));

  const short = text.replace(/\s+/g, ' ').trim().slice(0, 140);
  logger.info({ query: short, params }, '📥 [DB SQL EXEC] Exécution requête SQL');
  
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Timeout Supabase (5s)')), 5000)
  );
  
  return Promise.race([pool.query(text, params), timeout])
    .then(result => {
      logger.info({ query: short, rowsAffected: result.rowCount ?? result.rows?.length ?? 0 }, '📤 [DB SQL SUCCESS] Requête exécutée');
      return result;
    })
    .catch(err => {
      logger.error({ err, query: short, params }, '❌ [DB SQL ERROR] Échec de la requête SQL');
      throw err;
    });
}

// =========================================================================
// 4. CACHES MÉMOIRE (SÉCURISÉS & ATOMIQUES)
// =========================================================================
let cachedGroups = new Map();
let cachedAdmins = new Set();

async function refreshCaches() {
  if (!pool) return;
  logger.info('🔄 [CACHE CHARGEMENT] Début du rafraîchissement des caches...');
  try {
    const groups = await queryWithTimeout('SELECT group_jid, group_name FROM authorized_groups');
    const newGroups = new Map(groups.rows.map(r => [r.group_jid, r.group_name]));
    
    const admins = await queryWithTimeout('SELECT phone_number FROM bot_admins');
    const newAdmins = new Set(admins.rows.map(r => r.phone_number));

    cachedGroups = newGroups;
    cachedAdmins = newAdmins;
    
    logger.info({ 
      groupesAutorises: Array.from(cachedGroups.keys()), 
      adminsActifs: Array.from(cachedAdmins) 
    }, `✅ [CACHE CHARGÉ] Succès : ${cachedGroups.size} groupes et ${cachedAdmins.size} admins en mémoire.`);
  } catch (err) {
    logger.error({ err }, '❌ [CACHE ERREUR] Échec du rafraîchissement des caches (conservation des données antérieures)');
  }
}
setInterval(refreshCaches, 60 * 1000);

// =========================================================================
// 5. FONCTION KEEP-ALIVE (BDD SEULEMENT)
// =========================================================================
function startKeepAlive(intervalMs = 5 * 60 * 1000) {
  if (keepAliveTimer) clearInterval(keepAliveTimer);
  logger.info({ intervalMs }, '⏱️ [KEEP-ALIVE] Démarrage de la boucle Keep-Alive BDD');

  keepAliveTimer = setInterval(async () => {
    if (pool) {
      try {
        await queryWithTimeout('SELECT 1');
        logger.info('🟢 [KEEP-ALIVE PING] Ping Base de Données réussi.');
      } catch (err) {
        logger.error({ err }, '🔴 [KEEP-ALIVE PING] Échec du ping Base de Données.');
      }
    }
  }, intervalMs);
}

// =========================================================================
// 5bis. WATCHDOG SOCKET WHATSAPP (CORRECTIF PRINCIPAL DU GEL A 10-15 MIN)
// =========================================================================
// Diagnostic : le socket WebSocket sous-jacent peut devenir "zombie" - coupé
// au niveau reseau (proxy Render, NAT, etc.) SANS jamais declencher
// l'evenement 'close' de Baileys. Dans ce cas, `isReconnecting` reste false,
// `connection.update` ne se relance jamais, et le bot reste indefiniment
// "connecte" selon son propre etat interne tout en ne recevant plus aucun
// evenement. keepAliveIntervalMs (ping WebSocket interne a Baileys) est
// censé detecter ca, mais plusieurs environnements cloud le laissent passer.
//
// Ce watchdog fait un vrai aller-retour reseau (sendPresenceUpdate) toutes
// les 60s. S'il timeout ou echoue, on considere le socket mort et on force
// un redemarrage complet - au lieu d'attendre passivement un 'close' qui
// peut ne jamais arriver.
const WATCHDOG_INTERVAL_MS = 60 * 1000;
const WATCHDOG_TIMEOUT_MS = 15 * 1000;
let watchdogTimer = null;
let lastMessageEventAt = Date.now();

function startWatchdog() {
  if (watchdogTimer) clearInterval(watchdogTimer);
  logger.info('🐕 [WATCHDOG] Démarrage de la surveillance active du socket WhatsApp (toutes les 60s).');

  watchdogTimer = setInterval(async () => {
    if (!sock || isReconnecting) {
      logger.info('🐕 [WATCHDOG] Vérification ignorée (pas de socket actif ou reconnexion en cours).');
      return;
    }

    const silenceMs = Date.now() - lastMessageEventAt;
    logger.info({ silenceMs }, '🐕 [WATCHDOG] Vérification de la vivacité réelle du socket (sendPresenceUpdate)...');

    try {
      await Promise.race([
        sock.sendPresenceUpdate('available'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout watchdog (15s)')), WATCHDOG_TIMEOUT_MS)),
      ]);
      logger.info('🐕 [WATCHDOG] Socket vivant (presence update OK).');
    } catch (err) {
      logger.error({ err, silenceMs }, '💀 [WATCHDOG] Socket semble MORT (zombie) - redémarrage forcé du socket.');
      try {
        sock?.end?.(new Error('watchdog: socket zombie détecté'));
      } catch (e) {
        logger.error({ err: e }, '⚠️ [WATCHDOG] Erreur lors de la fermeture forcée du socket mort');
      }
      isReconnecting = false; // s'assurer qu'on peut relancer malgré l'etat precedent
      startSock().catch(e => logger.error({ err: e }, '💥 [WATCHDOG] Échec du redémarrage forcé'));
    }
  }, WATCHDOG_INTERVAL_MS);
}
startWatchdog();

// =========================================================================
// 6. PERMISSIONS ET UTILITAIRES DE NUMÉRO
// =========================================================================
function numberFromJid(jid) {
  if (!jid || typeof jid !== 'string') return '';
  return jid.split('@')[0].split(':')[0].replace(/\D/g, '').trim();
}

function senderNumberFromMsg(msg) {
  if (msg.key.fromMe) {
    return BOT_NUMBER || numberFromJid(sock?.user?.id);
  }
  return numberFromJid(msg.key.participant || msg.key.remoteJid);
}

function isSuperAdminNumber(n) { 
  if (!n) return false;
  return SUPER_ADMIN_NUMBERS.includes(n); 
}

function isBotAdmin(n) { 
  return isSuperAdminNumber(n) || cachedAdmins.has(n); 
}

async function resolveTargetNumber(msg) {
  const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
  if (contextInfo && contextInfo.mentionedJid && contextInfo.mentionedJid.length > 0) {
    return numberFromJid(contextInfo.mentionedJid[0]);
  }
  return senderNumberFromMsg(msg);
}

// =========================================================================
// 7. SOCKET WHATSAPP
// =========================================================================
let sock = null;
let processingMessages = new Set();
let isReconnecting = false;

async function startSock() {
  if (isReconnecting) {
    logger.warn('⚠️ [BOOT] Tentative de connexion annulée : Reconnexion déjà en cours.');
    return;
  }
  isReconnecting = true;

  if (sock) {
    try {
      logger.info('🔄 [BOOT] Fermeture du socket Baileys précédent...');
      sock.ev.removeAllListeners();
      sock.ws?.close();
    } catch (e) {
      logger.error({ err: e }, '⚠️ [BOOT] Erreur lors de la fermeture de l\'ancien socket');
    }
  }

  const authDir = path.join(__dirname, '.baileys_auth');

  logger.info('⚙️ [BOOT] Chargement des crédentiels et de la version Baileys...');
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();
  logger.info(`📦 [BOOT] Version Baileys utilisée : ${version.join('.')}`);

  sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: Browsers.macOS('Desktop'),
    generateHighQualityLinkPreview: false,
    getMessage: async () => undefined,
    // 🔹 FIX CRITIQUE: Force la ré-authentification si une clé de session est corrompue/manquante
    badSessionTokenWithNoRetry: false,
    appStateMacVerification: {
      patch: false,
      snapshot: false,
    },
    shouldSyncHistoryMessage: () => false,
    syncFullHistory: false,
    fireInitQueries: false,
    markOnlineOnConnect: false,
    // CORRIGÉ : `false` empêchait les messages envoyés par le numéro du bot
    // lui-même de déclencher 'messages.upsert' - or c'est justement le cas
    // d'usage central de ce bot (numéro du bot = numéro utilisé pour taper
    // les commandes /activer-groupe, etc.).
    emitOwnEvents: true,
    keepAliveIntervalMs: 25000,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    retryRequestOptions: {
      maxRetries: 5,
      delayMs: 500,
    },
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, qr, lastDisconnect } = update;

    if (qr) {
      logger.info('📱 [QR CODE] Génération d\'un nouveau QR Code...');
      try {
        currentQRCodeBase64 = await QRCode.toDataURL(qr);
        logger.info('✅ [QR CODE] QR Code transformé en Base64 et prêt sur la route /');
      } catch (err) {
        logger.error({ err }, '❌ [QR CODE] Échec de la conversion du QR code');
        currentQRCodeBase64 = null;
      }
    }

    if (connection === 'connecting') {
      logger.info('🔄 [CONNEXION] Tentative de connexion aux serveurs WhatsApp...');
    }

    if (connection === 'open') {
      isReconnecting = false;
      currentQRCodeBase64 = null;
      BOT_NUMBER = sock.user?.id ? numberFromJid(sock.user.id) : null;
      logger.info(`🎉 [CONNEXION SUCCÈS] Connecté à WhatsApp ! Numéro du Bot : ${BOT_NUMBER}`);
      
      startKeepAlive(5 * 60 * 1000);

      setTimeout(async () => {
        logger.info('⚡ [INITIALISATION POST-CONNEXION] Lancement du premier rafraîchissement du cache...');
        await refreshCaches();
        logger.info(`🚀 [BOT PRÊT] Bot 100% opérationnel ! ${cachedGroups.size} groupes autorisés, ${cachedAdmins.size} admins.`);
      }, 2000);
    }

    if (connection === 'close') {
      isReconnecting = false;
      if (keepAliveTimer) clearInterval(keepAliveTimer);

      const statusCode = lastDisconnect?.error?.output?.statusCode;
      logger.warn({ statusCode, err: lastDisconnect?.error }, '⚠️ [DECONNEXION] Connexion WhatsApp fermée.');
      
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      if (statusCode === DisconnectReason.restartRequired || statusCode === 515) {
        logger.info('🔄 [RESTART REQUIRED] Redémarrage immédiat du socket sans perte de session...');
        startSock();
      } else if (shouldReconnect) {
        logger.info('🔄 [RECONNEXION] Reconnexion automatique dans 5 secondes...');
        setTimeout(() => startSock(), 5000);
      } else {
        logger.error('🔴 [LOGGED OUT] Session fermée ou expirée. Nettoyage et régénération de la session...');
        if (fs.existsSync(authDir)) {
          try {
            fs.rmSync(authDir, { recursive: true, force: true });
            logger.info('🧹 [PURGE] Ancien dossier de session supprimé');
          } catch (e) {
            logger.error({ err: e }, '❌ [PURGE ERREUR] Échec de suppression du dossier de session');
          }
        }
        setTimeout(() => startSock(), 3000);
      }
    }
  });

  sock.ev.on('creds.update', () => {
    logger.info('💾 [CREDENTIALS] Sauvegarde des nouveaux tokens/clefs de session...');
    saveCreds();
  });

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    lastMessageEventAt = Date.now();
    logger.info({ messageCount: messages.length, upsertType: type }, '📩 [RECEPTION] Réception d\'un paquet de messages');
    if (type !== 'notify') return;

    for (const msg of messages) {
      setImmediate(async () => {
        try {
          await handleIncomingMessage(sock, msg);
        } catch (err) {
          logger.error({ err }, '❌ [MSG TRAITEMENT ERREUR] Échec du traitement du message');
        }
      });
    }
  });

  return sock;
}

// =========================================================================
// 8. XP BATCHING (TRANSFERT BDD)
// =========================================================================
let pendingXP = new Map();

async function flushPendingXP() {
  if (!pool || pendingXP.size === 0) return;
  
  const totalEntries = pendingXP.size;
  logger.info({ fileEnAttente: totalEntries }, `💾 [TRANSFERT XP BDD] Début du transfert par lots vers Supabase...`);
  
  const batch = new Map(pendingXP);
  pendingXP.clear();
  
  for (const [key, count] of batch) {
    const [groupJid, phoneNumber] = key.split('|');
    if (!phoneNumber) continue;
    
    logger.info({ groupJid, phoneNumber, xpAjouter: count }, `📤 [TRANSFERT XP BDD] Écriture de +${count} XP pour ${phoneNumber}...`);
    try {
      const res = await queryWithTimeout(
        `UPDATE users 
         SET xp = xp + $2,
             level = floor((xp + $2)/500) + 1
         WHERE phone_number = $1
         RETURNING xp, level, username`,
        [phoneNumber, count]
      );
      
      if (res.rowCount > 0) {
        logger.info({ 
          username: res.rows[0].username, 
          newTotalXp: res.rows[0].xp, 
          newLevel: res.rows[0].level 
        }, `✅ [TRANSFERT XP SUCCÈS] Mis à jour BDD : ${res.rows[0].username} -> Total: ${res.rows[0].xp} XP (Niveau ${res.rows[0].level})`);
      } else {
        logger.warn({ phoneNumber }, `⚠️ [TRANSFERT XP ANNULÉ] Le membre n'est pas inscrit en BDD.`);
      }
    } catch (err) {
      logger.error({ err, phoneNumber, count }, '❌ [TRANSFERT XP ERREUR] Échec mise à jour XP en BDD');
    }
  }
}
setInterval(flushPendingXP, 60 * 1000);

setInterval(() => {
  if (processingMessages.size > 2000) {
    logger.info({ taillePuge: processingMessages.size }, '🧹 [PURGE MEMOIRE] Nettoyage du registre des IDs de messages traités');
    processingMessages.clear();
  }
}, 10 * 60 * 1000);

// =========================================================================
// 9. TRAITEMENT DES MESSAGES
// =========================================================================
async function handleIncomingMessage(sockInstance, msg) {
  // 🔹 FIX CRITIQUE: Filtrer les messages système, les ratés de déchiffrement et les stubs
  if (!msg || !msg.message || msg.message.protocolMessage || msg.messageStubType) return;

  const from = msg.key?.remoteJid;
  if (!from) return;

  const author = msg.key.participant || from;
  const body = msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || '';

  if (!body.trim()) return;

  const msgId = msg.key.id;

  if (msgId && processingMessages.has(msgId)) {
    logger.info({ msgId }, '⏭️ [MSG IGNORÉ] Message déjà traité (Anti-doublon)');
    return;
  }
  if (msgId) processingMessages.add(msgId);

  try {
    if (!from.endsWith('@g.us')) {
      logger.info({ sender: author, text: body }, '💬 [MSG PRIVE] Message privé ignoré (XP actifs uniquement dans les groupes)');
      return;
    }
    
    if (msg.key.fromMe && !body.startsWith('/')) return;

    if (body.startsWith('/')) {
      logger.info({ chatJid: from, sender: author, commande: body }, '🎯 [COMMANDE DETECTION] Commande reçue');
      await handleCommand(sockInstance, msg, from, body);
      return;
    }

    if (!cachedGroups.has(from)) {
      logger.info({ chatJid: from }, '🛑 [GROUPE IGNORÉ] Groupe non activé pour l\'XP');
      return;
    }
    
    if (!pool) return;

    const authorNumber = numberFromJid(author);
    if (!authorNumber) return;

    const key = `${from}|${authorNumber}`;
    const newCount = (pendingXP.get(key) || 0) + XP_PER_MESSAGE;
    pendingXP.set(key, newCount);

    logger.info({ chatJid: from, authorNumber, xpEnAttente: newCount }, `✨ [XP ACQUIS] +${XP_PER_MESSAGE} XP en attente pour ${authorNumber}`);
  } finally {
    if (msgId) {
      setTimeout(() => processingMessages.delete(msgId), 10000);
    }
  }
}

// =========================================================================
// 10. COMMANDES
// =========================================================================
async function handleCommand(sockInstance, msg, chatJid, body) {
  const [raw, ...args] = body.split(/\s+/);
  const command = raw.toLowerCase();
  
  const senderNumber = senderNumberFromMsg(msg);
  logger.info({ command, senderNumber, chatJid, args }, '🚀 [EXECUTION COMMANDE] Début du traitement');

  const reply = async (text) => {
    try {
      logger.info({ chatJid, reponseText: text.slice(0, 100) }, '📤 [ENVOI MESSAGE] Réponse envoyée sur WhatsApp');
      await sockInstance.sendMessage(chatJid, { text }, { quoted: msg });
    } catch (err) {
      logger.error({ err, chatJid }, '❌ [ENVOI ERREUR] Échec d\'envoi du message WhatsApp');
    }
  };

  if (command === '/jid') {
    logger.info({ chatJid }, '⚡ [EXECUTION /jid] Affichage de l\'ID');
    await reply(`L'ID de ce chat est :\n\`${chatJid}\``);
    return;
  }

  if (!pool) {
    logger.warn('❌ [EXECUTION COMMANDE] Échec : Base de données indisponible.');
    await reply('Base de données indisponible.');
    return;
  }

  switch (command) {
    case '/menu': {
      logger.info({ senderNumber }, '📜 [EXECUTION /menu] Affichage du menu principal');
      const helpText = `📜 *MENU DU BOT*

👤 *MEMBRES & STATS*
🔹 */xp [@membre]* : Affiche le niveau/XP.
🔹 */sign <pseudo> [@membre]* : S'inscrire ou inscrire un membre.
🔹 */top* (ou */leaderboard*) : TOP 20 des membres les plus actifs.

🛠️ *ADMINISTRATEURS BOT*
🔸 */addxp @membre <montant>* : Ajouter de l'XP.
🔸 */removexp @membre <montant>* : Retirer de l'XP.

🔑 *SUPER ADMINS*
⚡ */activer-groupe* : Activer le système d'XP.
⚡ */desactiver-groupe* : Désactiver le système d'XP.
⚡ */add-admin @membre* : Ajouter un Admin Bot.
⚡ */remove-admin @membre* : Retirer un Admin Bot.

🔍 *UTILITAIRES*
ℹ️ */id* ou */jid* : Afficher l'identifiant du groupe.`;

      await reply(helpText);
      break;
    }

    case '/id':
      logger.info({ chatJid }, '⚡ [EXECUTION /id] Renvoi de l\'ID groupe');
      await reply(`ID groupe : ${chatJid}`);
      break;

    case '/activer-groupe': {
      logger.info({ senderNumber, chatJid }, '🔑 [EXECUTION /activer-groupe] Demande d\'activation');
      const isBot = BOT_NUMBER && senderNumber === BOT_NUMBER;
      const isSuper = isSuperAdminNumber(senderNumber);

      if (!isBot && !isSuper) {
        logger.warn({ senderNumber }, '🔒 [PERMISSION REFUSÉE] Seul le bot ou un Super Admin peut activer un groupe');
        await reply(`Accès refusé. Seul le bot (${BOT_NUMBER}) ou un Super Admin peut activer le groupe.`);
        return;
      }
      if (cachedGroups.has(chatJid)) {
        logger.info({ chatJid }, 'ℹ️ [GROUPE DÉJÀ ACTIF]');
        await reply('Groupe déjà activé.');
        return;
      }
      if (cachedGroups.size >= MAX_GROUPS) {
        logger.warn({ tailleActuelle: cachedGroups.size, max: MAX_GROUPS }, '⚠️ [LIMITE ATTEINTE] Impossible d\'ajouter un groupe');
        await reply(`Limite de ${MAX_GROUPS} groupes atteinte.`);
        return;
      }
      try {
        await queryWithTimeout(
          `INSERT INTO authorized_groups (group_jid, group_name, activated_by)
           VALUES ($1, $2, $3) ON CONFLICT (group_jid) DO NOTHING`,
          [chatJid, null, senderNumber]
        );
        cachedGroups.set(chatJid, null);
        logger.info({ chatJid, totalGroupes: cachedGroups.size }, '✅ [GROUPE ACTIVÉ] Ajouté en BDD et mis en cache');
        await reply(`✅ Groupe activé (${cachedGroups.size}/${MAX_GROUPS}).`);
      } catch (err) {
        logger.error({ err }, '❌ [DB ERROR] Échec /activer-groupe');
        await reply(`Erreur DB: ${err.message}`);
      }
      break;
    }

    case '/desactiver-groupe': {
      logger.info({ senderNumber, chatJid }, '🔑 [EXECUTION /desactiver-groupe] Demande de désactivation');
      const isBot = BOT_NUMBER && senderNumber === BOT_NUMBER;
      const isSuper = isSuperAdminNumber(senderNumber);

      if (!isBot && !isSuper) {
        logger.warn({ senderNumber }, '🔒 [PERMISSION REFUSÉE] /desactiver-groupe');
        await reply('Accès refusé.');
        return;
      }
      try {
        await queryWithTimeout('DELETE FROM authorized_groups WHERE group_jid = $1', [chatJid]);
        cachedGroups.delete(chatJid);
        logger.info({ chatJid }, '🔴 [GROUPE DÉSACTIVÉ] Supprimé de la BDD et du cache');
        await reply('🔴 Groupe désactivé.');
      } catch (err) {
        logger.error({ err }, '❌ [DB ERROR] Échec /desactiver-groupe');
        await reply('Erreur DB.');
      }
      break;
    }

    case '/addxp':
    case '/removexp': {
      logger.info({ command, senderNumber, args }, `🛠️ [EXECUTION ${command}] Modification d'XP`);
      if (!isBotAdmin(senderNumber)) {
        logger.warn({ senderNumber }, `🔒 [PERMISSION REFUSÉE] non-admin pour ${command}`);
        await reply('Non autorisé.');
        return;
      }
      const amount = parseInt(args.find(a => /^\d+$/.test(a)), 10);
      if (!amount || amount <= 0) {
        await reply(`Utilisation : ${command} @membre <montant>`);
        return;
      }
      const targetNumber = await resolveTargetNumber(msg);
      if (!targetNumber) {
        await reply('Cible introuvable.');
        return;
      }

      const delta = command === '/addxp' ? amount : -amount;
      try {
        logger.info({ targetNumber, delta }, '📥 [TRANSFERT XP ADMIN] Envoi de la requête de modification XP');
        // 🔹 FIX SECURITY: Recalcul correct du niveau en cas de réduction/ajout
        const result = await queryWithTimeout(
          `UPDATE users 
           SET xp = GREATEST(0, xp + $2),
               level = floor(GREATEST(0, xp + $2)/500) + 1
           WHERE phone_number = $1
           RETURNING *`,
          [targetNumber, delta]
        );
        
        if (result.rowCount === 0) {
          logger.warn({ targetNumber }, `⚠️ [MODIF XP ANNULÉE] Membre @${targetNumber} introuvable en BDD`);
          await reply(`⚠️ Ce membre (@${targetNumber}) n'est pas encore inscrit.`);
          return;
        }

        const member = result.rows[0];
        const verb = command === '/addxp' ? 'ajouté' : 'retiré';
        logger.info({ member: member.username, delta, total: member.xp }, `✅ [MODIF XP RÉUSSIE] ${verb} ${amount} XP`);
        await reply(
          `L'admin vient de ${verb} ${amount} XP à ${member.username} (@${targetNumber}) (total: ${member.xp} XP)`
        );
      } catch (err) {
        logger.error({ err }, `❌ [DB ERROR] ${command}`);
        await reply('Erreur DB.');
      }
      break;
    }

    case '/sign':
    case '/register': {
      logger.info({ senderNumber, args }, '📝 [EXECUTION /sign] Inscription d\'un utilisateur');
      if (args.length === 0) {
        await reply('Utilisation : /sign <pseudo> [@membre]\nExemple : /sign Président @membre');
        return;
      }

      const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
      const hasMention = contextInfo && contextInfo.mentionedJid && contextInfo.mentionedJid.length > 0;

      let targetNumber;
      let newUsername;

      if (hasMention) {
        if (!isBotAdmin(senderNumber)) {
          logger.warn({ senderNumber }, '🔒 [PERMISSION REFUSÉE] Inscription pour un tiers réservée aux admins');
          await reply('Seul un Admin du bot peut inscrire un autre membre.');
          return;
        }
        targetNumber = numberFromJid(contextInfo.mentionedJid[0]);
        newUsername = args.filter(a => !a.startsWith('@')).join(' ').trim();
      } else {
        targetNumber = senderNumber;
        newUsername = args.join(' ').trim();
      }

      if (!targetNumber || !newUsername) {
        await reply('Veuillez fournir un pseudo valide et cibler un membre valide.');
        return;
      }

      try {
        logger.info({ targetNumber, newUsername }, '📥 [TRANSFERT INSCRIPTION] Insertion / Mise à jour utilisateur BDD');
        const result = await queryWithTimeout(
          `INSERT INTO users (phone_number, username, xp, level)
           VALUES ($1, $2, 0, 1)
           ON CONFLICT (phone_number) 
           DO UPDATE SET username = EXCLUDED.username
           RETURNING *`,
          [targetNumber, newUsername]
        );

        const member = result.rows[0];
        logger.info({ member }, '✅ [INSCRIPTION RÉUSSIE] Utilisateur enregistré');
        await reply(`✅ Enregistrement réussi !\n👤 **Membre** : @${member.phone_number}\n🏷️ **Pseudo** : ${member.username}\n✨ **XP** : ${member.xp} | **Niveau** : ${member.level}`);
      } catch (err) {
        logger.error({ err }, '❌ [DB ERROR] Échec de la commande /sign');
        await reply('Erreur lors de l’inscription en BDD.');
      }
      break;
    }

    case '/add-admin':
      logger.info({ senderNumber }, '🔑 [EXECUTION /add-admin] Demande d\'ajout admin');
      if (!isSuperAdminNumber(senderNumber)) {
        logger.warn({ senderNumber }, '🔒 [PERMISSION REFUSÉE] Seul Super Admin peut exécuter /add-admin');
        await reply('Seul un Super Admin peut faire cela.');
        return;
      }
      try {
        const target = await resolveTargetNumber(msg);
        if (!target) {
          await reply('Cible introuvable.');
          return;
        }
        const res = await queryWithTimeout(
          'INSERT INTO bot_admins (phone_number, added_by) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING phone_number',
          [target, senderNumber]
        );
        if (res.rowCount > 0) {
          cachedAdmins.add(target);
          logger.info({ target }, '✅ [ADMIN AJOUTÉ] Nouvel admin ajouté en BDD et cache');
          await reply(`@${target} est maintenant admin.`);
        } else {
          logger.info({ target }, 'ℹ️ [ADMIN EXISTANT] L\'utilisateur était déjà admin');
          await reply(`@${target} est déjà admin.`);
        }
      } catch (err) {
        logger.error({ err }, '❌ [DB ERROR] Échec /add-admin');
        await reply('Erreur DB.');
      }
      break;

    case '/remove-admin':
      logger.info({ senderNumber }, '🔑 [EXECUTION /remove-admin] Demande de retrait admin');
      if (!isSuperAdminNumber(senderNumber)) {
        logger.warn({ senderNumber }, '🔒 [PERMISSION REFUSÉE] Seul Super Admin peut exécuter /remove-admin');
        await reply('Seul un Super Admin me permet de faire cela.');
        return;
      }
      try {
        const target = await resolveTargetNumber(msg);
        if (!target) {
          await reply('Cible introuvable.');
          return;
        }
        const res = await queryWithTimeout('DELETE FROM bot_admins WHERE phone_number = $1 RETURNING phone_number', [target]);
        if (res.rowCount > 0) {
          cachedAdmins.delete(target);
          logger.info({ target }, '🔴 [ADMIN RETIRÉ] Admin retiré de la BDD et du cache');
          await reply(`@${target} n’est plus admin.`);
        } else {
          logger.info({ target }, 'ℹ️ [ADMIN NON INTROUVABLE]');
          await reply(`@${target} n’était pas admin.`);
        }
      } catch (err) {
        logger.error({ err }, '❌ [DB ERROR] Échec /remove-admin');
        await reply('Erreur DB.');
      }
      break;

    case '/xp': {
      logger.info({ senderNumber }, '📊 [EXECUTION /xp] Consultation de niveau');
      const target = await resolveTargetNumber(msg);
      if (!target) {
        await reply('Cible introuvable.');
        return;
      }
      try {
        const res = await queryWithTimeout('SELECT * FROM users WHERE phone_number = $1', [target]);
        
        if (res.rows.length === 0) {
          logger.info({ target }, '⚠️ [XP CONSULTATION] Utilisateur non inscrit');
          await reply(`⚠️ @${target} n'est pas encore inscrit. Tapez \`/sign <pseudo>\` pour s'inscrire.`);
          return;
        }

        const m = res.rows[0];
        logger.info({ username: m.username, xp: m.xp, level: m.level }, '✅ [XP CONSULTATION SUCCESS]');
        await reply(`👤 **${m.username}** (@${m.phone_number})\n✨ **XP** : ${m.xp}\n📊 **Niveau** : ${m.level}`);
      } catch (err) {
        logger.error({ err }, '❌ [DB ERROR] Échec de la commande /xp');
        await reply('Erreur DB lors de la récupération de l’XP.');
      }
      break;
    }

    case '/top':
    case '/leaderboard': {
      logger.info({ senderNumber }, '🏆 [EXECUTION /top] Chargement du leaderboard');
      try {
        const res = await queryWithTimeout('SELECT * FROM users ORDER BY xp DESC LIMIT 20');
        if (res.rows.length === 0) {
          logger.info('ℹ️ [LEADERBOARD VIDE]');
          await reply('Aucun membre inscrit pour le moment.');
          return;
        }
        const lines = res.rows.map((m, i) => {
          const medal = MEDALS[i] || `#${i+1}`;
          return `${medal} ${m.username} - ${m.xp} XP (Niv. ${m.level})`;
        });
        logger.info({ totalMembresTop: res.rows.length }, '✅ [LEADERBOARD ENVOYÉ]');
        await reply(`🏆 Classement XP 🏆\n\n${lines.join('\n')}`);
      } catch (err) {
        logger.error({ err }, '❌ [DB ERROR] Échec de la commande /top');
        await reply('Erreur DB.');
      }
      break;
    }

    default:
      logger.info({ command }, '❓ [COMMANDE INCONNUE] La commande n\'est pas reconnue');
  }
}

// =========================================================================
// 11. DÉMARRAGE ET ARRÊT PROPRE
// =========================================================================
logger.info('🚀 [BOOT PROCESS] Démarrage du script bot.js...');
startSock().catch(err => logger.error({ err }, '💥 [BOOT CRITICAL ERROR] Échec du lancement de startSock()'));

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.warn({ signal }, `🛑 [SHUTDOWN] Signal ${signal} reçu. Nettoyage et arrêt du bot...`);
  if (keepAliveTimer) clearInterval(keepAliveTimer);
  logger.info('💾 [SHUTDOWN] Sauvegarde forcée des XP en attente avant fermeture...');
  await flushPendingXP();
  if (pool) {
    logger.info('🐘 [SHUTDOWN] Fermeture du pool PostgreSQL...');
    await pool.end();
  }
  logger.info('👋 [SHUTDOWN] Arrêt du processus Node.js terminé.');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));