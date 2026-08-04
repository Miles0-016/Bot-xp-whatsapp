/**
 * bot.js - Bot WhatsApp XP avec Baileys (Stabilisé & Optimisé)
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
// 1. CONFIGURATION & LOGGER VERBOSE
// =========================================================================
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  serializers: { err: pino.stdSerializers.err }
});

const MAX_GROUPS = 5;
const XP_PER_MESSAGE = 1;
const MEDALS = ['🥇', '🥈', '🥉'];

const SUPER_ADMIN_NUMBERS = (process.env.SUPER_ADMIN_NUMBERS || '')
  .split(',')
  .map(n => n.trim())
  .filter(Boolean);
if (SUPER_ADMIN_NUMBERS.length === 0) logger.warn('⚠️ SUPER_ADMIN_NUMBERS vide');

let currentQRCodeBase64 = null;
let BOT_NUMBER = null;
let keepAliveTimer = null;

// Anti-crash global
process.on('uncaughtException', err => logger.error({ err }, '[CRITICAL] Uncaught Exception'));
process.on('unhandledRejection', reason => logger.error({ reason }, '[CRITICAL] Unhandled Rejection'));

// =========================================================================
// 2. SERVEUR EXPRESS
// =========================================================================
const app = express();
const PORT = process.env.PORT || 8080;

app.get('/', (req, res) => {
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
  res.status(200).json({
    status: 'ok',
    qrAvailable: currentQRCodeBase64 !== null,
    groupesActifs: cachedGroups?.size || 0,
    adminsBot: cachedAdmins?.size || 0,
    pendingXP: pendingXP?.size || 0,
    botNumber: BOT_NUMBER,
    memory: process.memoryUsage(),
  });
});

app.listen(PORT, () => {
  logger.info(`[HTTP] Serveur Express démarré sur le port ${PORT}`);
});

// =========================================================================
// 3. BASE DE DONNÉES SUPABASE
// =========================================================================
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

if (!pool) logger.error('❌ DATABASE_URL absente');
else pool.on('error', err => logger.error({ err }, '[DB POOL ERROR]'));

function queryWithTimeout(text, params) {
  const short = text.replace(/\s+/g, ' ').trim().slice(0, 140);
  logger.debug(`[DB QUERY] ${short} ${params ? '| params=' + JSON.stringify(params) : ''}`);
  
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Timeout Supabase (5s)')), 5000)
  );
  
  return Promise.race([pool.query(text, params), timeout])
    .then(result => {
      logger.debug(`[DB OK] -> ${result.rowCount ?? result.rows?.length ?? 0} ligne(s)`);
      return result;
    })
    .catch(err => {
      logger.error({ err, query: short }, '[DB ERROR]');
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
  logger.info('[CACHE] Rafraîchissement en cours...');
  try {
    const groups = await queryWithTimeout('SELECT group_jid, group_name FROM authorized_groups');
    const newGroups = new Map(groups.rows.map(r => [r.group_jid, r.group_name]));
    
    const admins = await queryWithTimeout('SELECT phone_number FROM bot_admins');
    const newAdmins = new Set(admins.rows.map(r => r.phone_number));

    cachedGroups = newGroups;
    cachedAdmins = newAdmins;
    
    logger.info(`[CACHE] Mise à jour réussie : ${cachedGroups.size} groupes, ${cachedAdmins.size} admins`);
  } catch (err) {
    logger.error({ err }, '[CACHE] Échec du rafraîchissement (anciens caches conservés)');
  }
}
setInterval(refreshCaches, 60 * 1000);

// =========================================================================
// 5. FONCTION KEEP-ALIVE (BDD SEULEMENT)
// =========================================================================
function startKeepAlive(intervalMs = 5 * 60 * 1000) {
  if (keepAliveTimer) clearInterval(keepAliveTimer);

  keepAliveTimer = setInterval(async () => {
    if (pool) {
      try {
        await queryWithTimeout('SELECT 1');
        logger.debug('[KEEP-ALIVE] 🟢 Ping Base de Données réussi.');
      } catch (err) {
        logger.error({ err }, '[KEEP-ALIVE] 🔴 Échec du ping Base de Données.');
      }
    }
  }, intervalMs);
}

// =========================================================================
// 6. PERMISSIONS ET UTILITAIRES DE NUMÉRO
// =========================================================================
function numberFromJid(jid) {
  if (!jid) return '';
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
// 7. SOCKET WHATSAPP (BAILEYS - CORRIGÉ CORRUPTION SESSION & SYNCHRO)
// =========================================================================
let sock = null;
let processingMessages = new Set();
let isReconnecting = false;

async function startSock() {
  if (isReconnecting) return;
  isReconnecting = true;

  if (sock) {
    try {
      sock.ev.removeAllListeners();
      sock.ws?.close();
    } catch (_) {}
  }

  const authDir = path.join(__dirname, '.baileys_auth');
  logger.info('[BOOT] Initialisation du socket Baileys...');
  
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();
  logger.info(`[BOOT] Version Baileys: ${version.join('.')}`);

  sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: Browsers.macOS('Desktop'),
    generateHighQualityLinkPreview: false,
    getMessage: async () => undefined,
    // Annule la verification Mac/AppState qui cause l'erreur "tried remove, but no previous op"
    appStateMacVerification: {
      patch: false,
      snapshot: false,
    },
    // Empêche la récupération de l'historique WhatsApp au démarrage
    shouldSyncHistoryMessage: () => false,
    syncFullHistory: false,
    fireInitQueries: false,
    markOnlineOnConnect: false,
    emitOwnEvents: false,
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
      logger.info('[QR] 📱 Nouveau QR code généré.');
      try {
        currentQRCodeBase64 = await QRCode.toDataURL(qr);
      } catch (err) {
        logger.error({ err }, '[QR] Erreur conversion base64');
        currentQRCodeBase64 = null;
      }
    }

    if (connection === 'connecting') {
      logger.info('[CONNEXION] 🔄 Connexion aux serveurs WhatsApp...');
    }

    if (connection === 'open') {
      isReconnecting = false;
      currentQRCodeBase64 = null;
      BOT_NUMBER = sock.user?.id ? numberFromJid(sock.user.id) : null;
      logger.info(`[CONNEXION] ✅ CONNECTÉ ! Numéro Bot : ${BOT_NUMBER}`);
      
      startKeepAlive(5 * 60 * 1000);

      setTimeout(async () => {
        await refreshCaches();
        logger.info(`[READY] Bot opérationnel. ${cachedGroups.size} groupes, ${cachedAdmins.size} admins.`);
      }, 2000);
    }

    if (connection === 'close') {
      isReconnecting = false;
      if (keepAliveTimer) clearInterval(keepAliveTimer);

      const statusCode = lastDisconnect?.error?.output?.statusCode;
      logger.warn({ statusCode, err: lastDisconnect?.error }, '[DISCONNECTED] Connexion fermée.');
      
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      if (shouldReconnect) {
        logger.info('[RECONNECT] Tentative de reconnexion dans 5 secondes...');
        setTimeout(() => startSock(), 5000);
      } else {
        logger.error('[RECONNECT] Session fermée de manière définitive (Déconnecté). Nettoyage de la session...');
        try {
          fs.rmSync(authDir, { recursive: true, force: true });
          logger.info('[RECONNECT] Dossier .baileys_auth supprimé avec succès.');
        } catch (e) {
          logger.error({ err: e }, '[RECONNECT] Échec de la suppression du dossier auth');
        }
        setTimeout(() => startSock(), 5000);
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      setImmediate(async () => {
        try {
          await handleIncomingMessage(sock, msg);
        } catch (err) {
          logger.error({ err }, '[MSG ERROR] Erreur traitement message');
        }
      });
    }
  });

  return sock;
}

// =========================================================================
// 8. XP BATCHING (STRICTEMENT INSCRITS UNIQUEMENT)
// =========================================================================
let pendingXP = new Map();

async function flushPendingXP() {
  if (!pool || pendingXP.size === 0) return;
  const batch = new Map(pendingXP);
  pendingXP.clear();
  
  for (const [key, count] of batch) {
    const [groupJid, phoneNumber] = key.split('|');
    if (!phoneNumber) continue;
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
        logger.debug(`[XP SAVE] +${count} XP -> ${res.rows[0].username} (Total: ${res.rows[0].xp})`);
      }
    } catch (err) {
      logger.error({ err, phoneNumber }, '[XP ERROR] Échec mise à jour XP');
    }
  }
}
setInterval(flushPendingXP, 60 * 1000);

// Purge légère des IDs de messages
setInterval(() => {
  if (processingMessages.size > 2000) {
    processingMessages.clear();
  }
}, 10 * 60 * 1000);

// =========================================================================
// 9. TRAITEMENT DES MESSAGES
// =========================================================================
async function handleIncomingMessage(sockInstance, msg) {
  if (!msg.message || msg.message.protocolMessage) return;

  const from = msg.key.remoteJid;
  const author = msg.key.participant || from;
  const body = msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || '';

  if (!body.trim()) return;

  const msgId = msg.key.id;

  if (msgId && processingMessages.has(msgId)) return;
  if (msgId) processingMessages.add(msgId);

  try {
    if (!from.endsWith('@g.us')) return;
    if (msg.key.fromMe && !body.startsWith('/')) return;

    if (body.startsWith('/')) {
      logger.info({ from, author, body }, '[CMD INTERCEPT]');
      await handleCommand(sockInstance, msg, from, body);
      return;
    }

    if (!cachedGroups.has(from)) return;
    if (!pool) return;

    const authorNumber = numberFromJid(author);
    const key = `${from}|${authorNumber}`;
    pendingXP.set(key, (pendingXP.get(key) || 0) + XP_PER_MESSAGE);
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
  logger.info({ command, senderNumber, chatJid }, '[CMD EXEC]');

  const reply = async (text) => {
    await sockInstance.sendMessage(chatJid, { text }, { quoted: msg });
  };

  if (command === '/jid') {
    await reply(`L'ID de ce chat est :\n\`${chatJid}\``);
    return;
  }

  if (!pool) {
    await reply('Base de données indisponible.');
    return;
  }

  switch (command) {
    case '/menu': {
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
      await reply(`ID groupe : ${chatJid}`);
      break;

    case '/activer-groupe': {
      const isBot = BOT_NUMBER && senderNumber === BOT_NUMBER;
      const isSuper = isSuperAdminNumber(senderNumber);

      if (!isBot && !isSuper) {
        await reply(`Accès refusé. Seul le bot (${BOT_NUMBER}) ou un Super Admin peut activer le groupe.`);
        return;
      }
      if (cachedGroups.has(chatJid)) {
        await reply('Groupe déjà activé.');
        return;
      }
      if (cachedGroups.size >= MAX_GROUPS) {
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
        await reply(`✅ Groupe activé (${cachedGroups.size}/${MAX_GROUPS}).`);
      } catch (err) {
        logger.error({ err }, '[DB ERROR] /activer-groupe');
        await reply(`Erreur DB: ${err.message}`);
      }
      break;
    }

    case '/desactiver-groupe': {
      const isBot = BOT_NUMBER && senderNumber === BOT_NUMBER;
      const isSuper = isSuperAdminNumber(senderNumber);

      if (!isBot && !isSuper) {
        await reply('Accès refusé.');
        return;
      }
      try {
        await queryWithTimeout('DELETE FROM authorized_groups WHERE group_jid = $1', [chatJid]);
        cachedGroups.delete(chatJid);
        await reply('🔴 Groupe désactivé.');
      } catch (err) {
        logger.error({ err }, '[DB ERROR] /desactiver-groupe');
        await reply('Erreur DB.');
      }
      break;
    }

    case '/addxp':
    case '/removexp': {
      if (!isBotAdmin(senderNumber)) {
        await reply('Non autorisé.');
        return;
      }
      const amount = parseInt(args.find(a => /^\d+$/.test(a)), 10);
      if (!amount || amount <= 0) {
        await reply(`Utilisation : ${command} @membre <montant>`);
        return;
      }
      const targetNumber = await resolveTargetNumber(msg);
      const delta = command === '/addxp' ? amount : -amount;
      try {
        const result = await queryWithTimeout(
          `UPDATE users 
           SET xp = GREATEST(0, xp + $2),
               level = floor(GREATEST(0, xp + $2)/500) + 1
           WHERE phone_number = $1
           RETURNING *`,
          [targetNumber, delta]
        );
        
        if (result.rowCount === 0) {
          await reply(`⚠️ Ce membre (@${targetNumber}) n'est pas encore inscrit.`);
          return;
        }

        const member = result.rows[0];
        const verb = command === '/addxp' ? 'ajouté' : 'retiré';
        await reply(
          `L'admin vient de ${verb} ${amount} XP à ${member.username} (@${targetNumber}) (total: ${member.xp} XP)`
        );
      } catch (err) {
        logger.error({ err }, `[DB ERROR] ${command}`);
        await reply('Erreur DB.');
      }
      break;
    }

    case '/sign':
    case '/register': {
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
          await reply('Seul un Admin du bot peut inscrire un autre membre.');
          return;
        }
        targetNumber = numberFromJid(contextInfo.mentionedJid[0]);
        newUsername = args.filter(a => !a.startsWith('@')).join(' ').trim();
      } else {
        targetNumber = senderNumber;
        newUsername = args.join(' ').trim();
      }

      if (!newUsername) {
        await reply('Veuillez fournir un pseudo valide.');
        return;
      }

      try {
        const result = await queryWithTimeout(
          `INSERT INTO users (phone_number, username, xp, level)
           VALUES ($1, $2, 0, 1)
           ON CONFLICT (phone_number) 
           DO UPDATE SET username = EXCLUDED.username
           RETURNING *`,
          [targetNumber, newUsername]
        );

        const member = result.rows[0];
        await reply(`✅ Enregistrement réussi !\n👤 **Membre** : @${member.phone_number}\n🏷️ **Pseudo** : ${member.username}\n✨ **XP** : ${member.xp} | **Niveau** : ${member.level}`);
      } catch (err) {
        logger.error({ err }, '[DB ERROR] /sign');
        await reply('Erreur lors de l’inscription en BDD.');
      }
      break;
    }

    case '/add-admin':
      if (!isSuperAdminNumber(senderNumber)) {
        await reply('Seul un Super Admin peut faire cela.');
        return;
      }
      try {
        const target = await resolveTargetNumber(msg);
        const res = await queryWithTimeout(
          'INSERT INTO bot_admins (phone_number, added_by) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING phone_number',
          [target, senderNumber]
        );
        if (res.rowCount > 0) {
          cachedAdmins.add(target);
          await reply(`@${target} est maintenant admin.`);
        } else {
          await reply(`@${target} est déjà admin.`);
        }
      } catch (err) {
        logger.error({ err }, '[DB ERROR] /add-admin');
        await reply('Erreur DB.');
      }
      break;

    case '/remove-admin':
      if (!isSuperAdminNumber(senderNumber)) {
        await reply('Seul un Super Admin me permet de faire cela.');
        return;
      }
      try {
        const target = await resolveTargetNumber(msg);
        const res = await queryWithTimeout('DELETE FROM bot_admins WHERE phone_number = $1 RETURNING phone_number', [target]);
        if (res.rowCount > 0) {
          cachedAdmins.delete(target);
          await reply(`@${target} n’est plus admin.`);
        } else {
          await reply(`@${target} n’était pas admin.`);
        }
      } catch (err) {
        logger.error({ err }, '[DB ERROR] /remove-admin');
        await reply('Erreur DB.');
      }
      break;

    case '/xp': {
      const target = await resolveTargetNumber(msg);
      try {
        const res = await queryWithTimeout('SELECT * FROM users WHERE phone_number = $1', [target]);
        
        if (res.rows.length === 0) {
          await reply(`⚠️ @${target} n'est pas encore inscrit. Tapez \`/sign <pseudo>\` pour s'inscrire.`);
          return;
        }

        const m = res.rows[0];
        await reply(`👤 **${m.username}** (@${m.phone_number})\n✨ **XP** : ${m.xp}\n📊 **Niveau** : ${m.level}`);
      } catch (err) {
        logger.error({ err }, '[DB ERROR] /xp');
        await reply('Erreur DB lors de la récupération de l’XP.');
      }
      break;
    }

    case '/top':
    case '/leaderboard': {
      try {
        const res = await queryWithTimeout('SELECT * FROM users ORDER BY xp DESC LIMIT 20');
        if (res.rows.length === 0) {
          await reply('Aucun membre inscrit pour le moment.');
          return;
        }
        const lines = res.rows.map((m, i) => {
          const medal = MEDALS[i] || `#${i+1}`;
          return `${medal} ${m.username} - ${m.xp} XP (Niv. ${m.level})`;
        });
        await reply(`🏆 Classement XP 🏆\n\n${lines.join('\n')}`);
      } catch (err) {
        logger.error({ err }, '[DB ERROR] /top');
        await reply('Erreur DB.');
      }
      break;
    }

    default:
      logger.debug({ command }, '[CMD] Inconnue');
  }
}

// =========================================================================
// 11. DÉMARRAGE ET ARRÊT PROPRE
// =========================================================================
logger.info('[BOOT] Démarrage du bot...');
startSock().catch(err => logger.error({ err }, '[BOOT ERROR]'));

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.warn(`[SHUTDOWN] Signal ${signal} reçu.`);
  if (keepAliveTimer) clearInterval(keepAliveTimer);
  await flushPendingXP();
  if (pool) await pool.end();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));