/**
 * bot.js - Bot WhatsApp XP avec Baileys & Vidage Mémoire RAM (1 min)
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
const http = require('http');

// Baileys
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
  initAuthCreds,
  proto,
} = require('@whiskeysockets/baileys');

// =========================================================================
// 1. CONFIGURATION & LOGGER VERBOSE EXHAUSTIF
// =========================================================================
const logger = pino({
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
let selfPingTimer = null;
let memoryCleanTimer = null;

// Anti-crash global
process.on('uncaughtException', err => logger.error({ err }, '💥 [CRITICAL] Uncaught Exception intercepté'));
process.on('unhandledRejection', reason => logger.error({ reason }, '💥 [CRITICAL] Unhandled Rejection intercepté'));

// =========================================================================
// 2. SERVEUR EXPRESS & AUTO-PING INTERNE (RENDER KEEP-ALIVE)
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
    res.send('<html><body style="background:#0f172a;color:#4ade80;display:flex;justify-content:center;align-items:center;height:100vh;"><h2>✅ Bot en ligne 24h/24 (RAM Nettoyée)</h2></body></html>');
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
    dernierMessageRecuDepuis_ms: Date.now() - lastMessageEventAt,
    memory: process.memoryUsage(),
  });
});

app.listen(PORT, () => {
  logger.info(`🚀 [HTTP] Serveur Express démarré sur le port ${PORT}`);
  startSelfPing();
});

function startSelfPing() {
  const appUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  if (selfPingTimer) clearInterval(selfPingTimer);
  
  selfPingTimer = setInterval(() => {
    http.get(`${appUrl}/health`, (res) => {}).on('error', (err) => {});
  }, 4 * 60 * 1000);
}

// =========================================================================
// 3. BASE DE DONNÉES SUPABASE
// =========================================================================
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 3,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 10000,
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

  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Timeout Supabase (5s)')), 5000)
  );
  
  return Promise.race([pool.query(text, params), timeout]);
}

// =========================================================================
// 4. CACHES MÉMOIRE & NETTOYAGE RAM STRICT (TOUTES LES 1 MIN)
// =========================================================================
let cachedGroups = new Map();
let cachedAdmins = new Set();
let targetPingGroupJid = null;
let pendingXP = new Map();
let processingMessages = new Set();

async function refreshCaches() {
  if (!pool) return;
  try {
    const groups = await queryWithTimeout('SELECT group_jid, group_name FROM authorized_groups');
    cachedGroups = new Map(groups.rows.map(r => [r.group_jid, r.group_name]));
    
    const admins = await queryWithTimeout('SELECT phone_number FROM bot_admins');
    cachedAdmins = new Set(admins.rows.map(r => r.phone_number));

    try {
      const configRes = await queryWithTimeout("SELECT value FROM bot_config WHERE key = 'ping_target_group'");
      if (configRes.rows.length > 0) {
        targetPingGroupJid = configRes.rows[0].value;
      }
    } catch (e) {}
  } catch (err) {}
}
setInterval(refreshCaches, 60 * 1000);

// --- FONCTION DE NETTOYAGE AGRESSIF DE LA RAM (Toutes les 1 min) ---
function startMemoryCleaner() {
  if (memoryCleanTimer) clearInterval(memoryCleanTimer);
  logger.info('🧹 [RAM CLEANER] Démarrage du nettoyage de la RAM (toutes les 1 min)');

  memoryCleanTimer = setInterval(async () => {
    try {
      if (pendingXP.size > 0) {
        const batch = new Map(pendingXP);
        pendingXP.clear();
        
        for (const [key, count] of batch) {
          const [groupJid, phoneNumber] = key.split('|');
          if (!phoneNumber) continue;
          try {
            await queryWithTimeout(
              `UPDATE users SET xp = xp + $2, level = floor((xp + $2)/500) + 1 WHERE phone_number = $1`,
              [phoneNumber, count]
            );
          } catch (e) {}
        }
        logger.info('💾 [RAM CLEANER] Données XP flushées et purgées de la RAM.');
      }

      if (processingMessages.size > 0) {
        processingMessages.clear();
      }

      if (global.gc) {
        global.gc();
      }
      
      logger.info({ memoryUsage: process.memoryUsage() }, '✨ [RAM CLEANER] Nettoyage RAM effectué avec succès.');
    } catch (err) {
      logger.error({ err }, '❌ [RAM CLEANER ERROR] Erreur lors du nettoyage de la RAM');
    }
  }, 60 * 1000);
}

// =========================================================================
// 5. KEEP-ALIVE & WATCHDOG
// =========================================================================
function startKeepAlive(intervalMs = 5 * 60 * 1000) {
  if (keepAliveTimer) clearInterval(keepAliveTimer);
  keepAliveTimer = setInterval(async () => {
    if (pool) {
      try { await queryWithTimeout('SELECT 1'); } catch (err) {}
    }
  }, intervalMs);
}

const WATCHDOG_INTERVAL_MS = 60 * 1000;
let watchdogTimer = null;
let lastMessageEventAt = Date.now();

function startWatchdog() {
  if (watchdogTimer) clearInterval(watchdogTimer);
  watchdogTimer = setInterval(async () => {
    if (!sock || isReconnecting) return;
    try {
      await Promise.race([
        sock.sendPresenceUpdate('available'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 10000)),
      ]);
    } catch (err) {
      try { sock?.end?.(new Error('watchdog')); } catch (e) {}
      isReconnecting = false;
      startSock().catch(e => {});
    }
  }, WATCHDOG_INTERVAL_MS);
}
startWatchdog();

let groupPingTimer = null;
function startGroupPing(intervalMs = 5 * 60 * 1000) {
  if (groupPingTimer) clearInterval(groupPingTimer);
  groupPingTimer = setInterval(async () => {
    if (!sock || isReconnecting || !targetPingGroupJid) return;
    try {
      await sock.sendMessage(targetPingGroupJid, { text: '🤖 [Auto-Ping Anti-Inactivité] Le bot est en ligne !' });
    } catch (err) {}
  }, intervalMs);
}

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
// 7. AUTHENTIFICATION BAILEYS STOCKÉE DANS SUPABASE (PERSISTANCE RENDER)
// =========================================================================
async function useSupabaseAuthState() {
  // S'assure que la table des sessions existe
  try {
    await queryWithTimeout(`
      CREATE TABLE IF NOT EXISTS bot_sessions (
        session_id VARCHAR(255) PRIMARY KEY,
        session_data TEXT NOT NULL
      )
    `);
  } catch (e) {}

  const writeData = async (data, id) => {
    const jsonString = JSON.stringify(data, (_, val) => Buffer.isBuffer(val) ? { type: 'Buffer', data: Array.from(val) } : val);
    await queryWithTimeout(
      `INSERT INTO bot_sessions (session_id, session_data) VALUES ($1, $2) ON CONFLICT (session_id) DO UPDATE SET session_data = EXCLUDED.session_data`,
      [id, jsonString]
    );
  };

  const readData = async (id) => {
    try {
      const res = await queryWithTimeout(`SELECT session_data FROM bot_sessions WHERE session_id = $1`, [id]);
      if (res.rows.length === 0) return null;
      const data = JSON.parse(res.rows[0].session_data, (_, val) => {
        if (val !== null && typeof val === 'object' && val.type === 'Buffer' && Array.isArray(val.data)) {
          return Buffer.from(val.data);
        }
        return val;
      });
      return data;
    } catch (error) {
      return null;
    }
  };

  const removeData = async (id) => {
    try {
      await queryWithTimeout(`DELETE FROM bot_sessions WHERE session_id = $1`, [id]);
    } catch (error) {}
  };

  const creds = (await readData('creds')) || (await initAuthCreds());

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          for (const id of ids) {
            let value = await readData(`${type}-${id}`);
            if (type === 'app-state-sync-key' && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            data[id] = value;
          }
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category of Object.keys(data)) {
            for (const id of Object.keys(data[category])) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              if (value) {
                tasks.push(writeData(value, key));
              } else {
                tasks.push(removeData(key));
              }
            }
          }
          await Promise.all(tasks);
        }
      }
    },
    // CORRECTION APPORTÉE ICI : Utilisation de 'creds' au lieu de 'state.creds'
    saveCreds: () => writeData(creds, 'creds')
  };
}

// =========================================================================
// 8. SOCKET WHATSAPP
// =========================================================================
let sock = null;
let isReconnecting = false;

async function startSock() {
  if (isReconnecting) return;
  isReconnecting = true;

  if (sock) {
    try {
      sock.ev.removeAllListeners();
      sock.ws?.close();
    } catch (e) {}
  }

  const { state, saveCreds } = await useSupabaseAuthState();
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: Browsers.macOS('Desktop'),
    generateHighQualityLinkPreview: false,
    getMessage: async () => undefined,
    badSessionTokenWithNoRetry: false,
    appStateMacVerification: { patch: false, snapshot: false },
    shouldSyncHistoryMessage: () => false,
    syncFullHistory: false,
    fireInitQueries: false,
    markOnlineOnConnect: false,
    emitOwnEvents: true,
    keepAliveIntervalMs: 25000,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    retryRequestOptions: { maxRetries: 5, delayMs: 500 },
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, qr, lastDisconnect } = update;

    if (qr) {
      try {
        currentQRCodeBase64 = await QRCode.toDataURL(qr);
      } catch (err) {
        currentQRCodeBase64 = null;
      }
    }

    if (connection === 'open') {
      isReconnecting = false;
      currentQRCodeBase64 = null;
      BOT_NUMBER = sock.user?.id ? numberFromJid(sock.user.id) : null;
      logger.info(`🎉 [CONNEXION SUCCÈS] Connecté à WhatsApp ! Numéro du Bot : ${BOT_NUMBER}`);
      
      startKeepAlive(5 * 60 * 1000);
      startGroupPing(5 * 60 * 1000);
      startMemoryCleaner();

      setTimeout(async () => {
        await refreshCaches();
      }, 2000);
    }

    if (connection === 'close') {
      isReconnecting = false;
      if (keepAliveTimer) clearInterval(keepAliveTimer);
      if (groupPingTimer) clearInterval(groupPingTimer);
      if (memoryCleanTimer) clearInterval(memoryCleanTimer);

      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      if (statusCode === DisconnectReason.restartRequired || statusCode === 515) {
        startSock();
      } else if (shouldReconnect) {
        setTimeout(() => startSock(), 5000);
      } else {
        // En cas de déconnexion totale (loggedOut), on nettoie la table en BDD
        try {
          await queryWithTimeout('DELETE FROM bot_sessions');
        } catch (e) {}
        setTimeout(() => startSock(), 3000);
      }
    }
  });

  sock.ev.on('creds.update', () => { saveCreds(); });

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    lastMessageEventAt = Date.now();
    if (type !== 'notify') return;

    for (const msg of messages) {
      setImmediate(async () => {
        try {
          await handleIncomingMessage(sock, msg);
        } catch (err) {}
      });
    }
  });

  return sock;
}

// =========================================================================
// 9. TRAITEMENT DES MESSAGES
// =========================================================================
async function handleIncomingMessage(sockInstance, msg) {
  if (!msg || !msg.message || msg.message.protocolMessage || msg.messageStubType) return;

  const from = msg.key?.remoteJid;
  if (!from) return;

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
      await handleCommand(sockInstance, msg, from, body);
      return;
    }

    if (!cachedGroups.has(from)) return;
    if (!pool) return;

    const authorNumber = numberFromJid(author);
    if (!authorNumber) return;

    const key = `${from}|${authorNumber}`;
    const newCount = (pendingXP.get(key) || 0) + XP_PER_MESSAGE;
    pendingXP.set(key, newCount);
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

  const reply = async (text) => {
    try {
      await sockInstance.sendMessage(chatJid, { text }, { quoted: msg });
    } catch (err) {}
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
🔹 */top* : TOP 20 des membres les plus actifs.

🛠️ *ADMINISTRATEURS BOT*
🔸 */addxp @membre <montant>* : Ajouter de l'XP.
🔸 */removexp @membre <montant>* : Retirer de l'XP.

🔑 *SUPER ADMINS*
⚡ */activer-groupe* : Activer le système d'XP.
⚡ */desactiver-groupe* : Désactiver le système d'XP.
⚡ */set-ping-group* : Définir ce groupe pour l'auto-ping (toutes les 5 min).
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
        await reply(`Accès refusé.`);
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
        await reply(`Erreur DB.`);
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
        
        if (targetPingGroupJid === chatJid) {
          targetPingGroupJid = null;
          await queryWithTimeout("DELETE FROM bot_config WHERE key = 'ping_target_group'");
        }

        await reply('🔴 Groupe désactivé.');
      } catch (err) {
        await reply('Erreur DB.');
      }
      break;
    }

    case '/set-ping-group': {
      const isBot = BOT_NUMBER && senderNumber === BOT_NUMBER;
      const isSuper = isSuperAdminNumber(senderNumber);

      if (!isBot && !isSuper) {
        await reply('Accès refusé. Réservé aux super admins.');
        return;
      }

      if (!chatJid.endsWith('@g.us')) {
        await reply('Cette commande doit être exécutée directement dans le groupe cible.');
        return;
      }

      try {
        await queryWithTimeout(`
          CREATE TABLE IF NOT EXISTS bot_config (
            key VARCHAR(50) PRIMARY KEY,
            value TEXT NOT NULL
          )
        `);

        await queryWithTimeout(
          `INSERT INTO bot_config (key, value) VALUES ('ping_target_group', $1)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
          [chatJid]
        );

        targetPingGroupJid = chatJid;
        await reply(`✅ Ce groupe a été défini avec succès comme cible pour l'auto-ping anti-inactivité (toutes les 5 min).`);
      } catch (err) {
        await reply('Erreur lors de l\'enregistrement du groupe de ping.');
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
      if (!targetNumber) {
        await reply('Cible introuvable.');
        return;
      }

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
        await reply('Erreur DB.');
      }
      break;
    }

    case '/sign':
    case '/register': {
      if (args.length === 0) {
        await reply('Utilisation : /sign <pseudo> [@membre]');
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

      if (!targetNumber || !newUsername) {
        await reply('Veuillez fournir un pseudo valide et cibler un membre valide.');
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
          await reply(`@${target} est maintenant admin.`);
        } else {
          await reply(`@${target} est déjà admin.`);
        }
      } catch (err) {
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
        if (!target) {
          await reply('Cible introuvable.');
          return;
        }
        const res = await queryWithTimeout('DELETE FROM bot_admins WHERE phone_number = $1 RETURNING phone_number', [target]);
        if (res.rowCount > 0) {
          cachedAdmins.delete(target);
          await reply(`@${target} n’est plus admin.`);
        } else {
          await reply(`@${target} n’était pas admin.`);
        }
      } catch (err) {
        await reply('Erreur DB.');
      }
      break;

    case '/xp': {
      const target = await resolveTargetNumber(msg);
      if (!target) {
        await reply('Cible introuvable.');
        return;
      }
      try {
        const res = await queryWithTimeout('SELECT * FROM users WHERE phone_number = $1', [target]);
        
        if (res.rows.length === 0) {
          await reply(`⚠️ @${target} n'est pas encore inscrit. Tapez \`/sign <pseudo>\` pour s'inscrire.`);
          return;
        }

        const m = res.rows[0];
        await reply(`👤 **${m.username}** (@${m.phone_number})\n✨ **XP** : ${m.xp}\n📊 **Niveau** : ${m.level}`);
      } catch (err) {
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
        await reply('Erreur DB.');
      }
      break;
    }

    default:
      break;
  }
}

// =========================================================================
// 11. DÉMARRAGE ET ARRÊT PROPRE
// =========================================================================
startSock().catch(err => {});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (keepAliveTimer) clearInterval(keepAliveTimer);
  if (groupPingTimer) clearInterval(groupPingTimer);
  if (selfPingTimer) clearInterval(selfPingTimer);
  if (memoryCleanTimer) clearInterval(memoryCleanTimer);
  
  try {
    if (pendingXP.size > 0 && pool) {
      for (const [key, count] of pendingXP) {
        const [_, phoneNumber] = key.split('|');
        if (phoneNumber) {
          await pool.query(`UPDATE users SET xp = xp + $2 WHERE phone_number = $1`, [phoneNumber, count]);
        }
      }
    }
  } catch (e) {}

  if (pool) {
    await pool.end();
  }
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));