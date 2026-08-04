/**
 * bot.js - Bot WhatsApp XP avec Baileys (léger, sans Puppeteer)
 * 
 * - Serveur Express démarré en premier
 * - Logs de connexion ultra-détaillés : QR, connexion, synchronisation, ready
 * - Gestion de session persistante (MultiFileAuthState)
 * - Toute la logique métier (Supabase, caches, XP batching)
 */

const path = require('path');
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
// 1. CONFIGURATION
// =========================================================================
const MAX_GROUPS = 5;
const XP_PER_MESSAGE = 1;
const MEDALS = ['🥇', '🥈', '🥉'];

const SUPER_ADMIN_NUMBERS = (process.env.SUPER_ADMIN_NUMBERS || '')
  .split(',')
  .map(n => n.trim())
  .filter(Boolean);
if (SUPER_ADMIN_NUMBERS.length === 0) console.warn('⚠️ SUPER_ADMIN_NUMBERS vide');

let currentQRCodeBase64 = null;
let BOT_NUMBER = null; // sera rempli après la connexion

// =========================================================================
// 2. SERVEUR EXPRESS (démarré immédiatement)
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

const server = app.listen(PORT, () => {
  console.log(`[HTTP] Serveur Express démarré sur le port ${PORT} (avant l'initialisation du bot)`);
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
if (!pool) console.error('❌ DATABASE_URL absente');
else pool.on('error', err => console.error('[DB POOL ERROR]', err.message));

function queryWithTimeout(text, params) {
  const short = text.replace(/\s+/g, ' ').trim().slice(0, 140);
  console.log(`[DB QUERY] ${short}${params ? ' | params='+JSON.stringify(params) : ''}`);
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Timeout Supabase (6s)')), 6000)
  );
  return Promise.race([pool.query(text, params), timeout])
    .then(result => {
      console.log(`[DB QUERY OK] -> ${result.rowCount ?? result.rows?.length ?? 0} ligne(s)`);
      return result;
    })
    .catch(err => {
      console.error(`[DB ERROR] ${short} :`, err.stack || err.message);
      throw err;
    });
}

// =========================================================================
// 4. CACHES MÉMOIRE
// =========================================================================
let cachedGroups = new Map();
let cachedAdmins = new Set();

async function refreshCaches() {
  if (!pool) return;
  console.log('[CACHE] Rafraîchissement...');
  try {
    const groups = await queryWithTimeout('SELECT group_jid, group_name FROM authorized_groups');
    cachedGroups = new Map(groups.rows.map(r => [r.group_jid, r.group_name]));
    const admins = await queryWithTimeout('SELECT phone_number FROM bot_admins');
    cachedAdmins = new Set(admins.rows.map(r => r.phone_number));
    console.log(`[CACHE] ${cachedGroups.size} groupes, ${cachedAdmins.size} admins`);
  } catch (err) {
    console.error('[CACHE] Erreur:', err.message);
  }
}
setInterval(refreshCaches, 60 * 1000);

// =========================================================================
// 5. PERMISSIONS
// =========================================================================
function numberFromJid(jid) {
  return (jid || '').split('@')[0];
}
function senderNumberFromMsg(msg) {
  const fromMe = msg.key.fromMe;
  if (fromMe) return BOT_NUMBER || numberFromJid(msg.key.remoteJid);
  return numberFromJid(msg.key.participant || msg.key.remoteJid);
}
function isSuperAdminNumber(n) { return SUPER_ADMIN_NUMBERS.includes(n); }
function isBotAdmin(n) { return isSuperAdminNumber(n) || cachedAdmins.has(n); }

async function resolveTargetNumber(msg) {
  const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
  if (contextInfo && contextInfo.mentionedJid && contextInfo.mentionedJid.length > 0) {
    return numberFromJid(contextInfo.mentionedJid[0]);
  }
  return senderNumberFromMsg(msg);
}

// =========================================================================
// 6. SOCKET WHATSAPP (BAILEYS)
// =========================================================================
let sock = null;
let processingMessages = new Set();

async function startSock() {
  console.log('[BOOT] Initialisation du socket Baileys...');
  const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, '.baileys_auth'));
  const { version } = await fetchLatestBaileysVersion();
  console.log(`[BOOT] Version Baileys: ${version.join('.')}`);

  // Correction de la variable globale sock (évite la rédéclaration locale)
  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: Browsers.macOS('Desktop'),
    logger: pino({ level: 'info', transport: { target: 'pino-pretty' } }),
    generateHighQualityLinkPreview: false,
    getMessage: async () => undefined,
    shouldSyncHistoryMessage: () => false,
  });

  // Événement : connexion
  sock.ev.on('connection.update', async (update) => {
    const { connection, qr, lastDisconnect } = update;

    if (qr) {
      console.log('[QR] 📱 Nouveau QR code généré (en attente de scan)');
      try {
        currentQRCodeBase64 = await QRCode.toDataURL(qr);
        console.log('[QR] QR code disponible sur la page web /');
      } catch (err) {
        console.error('[QR] Erreur génération image:', err.message);
        currentQRCodeBase64 = null;
      }
    }

    if (connection === 'connecting') {
      console.log('[CONNEXION] 🔄 Connexion en cours... (établissement du WebSocket)');
    }

    if (connection === 'open') {
      currentQRCodeBase64 = null;
      BOT_NUMBER = sock.user?.id ? numberFromJid(sock.user.id) : null;
      console.log(`[CONNEXION] ✅ CONNECTÉ ! Numéro du bot : ${BOT_NUMBER}`);
      console.log(`[CONNEXION] Mémoire utilisée : ${Math.round(process.memoryUsage().rss / 1024 / 1024)} Mo`);
      console.log('[CONNEXION] Synchronisation des messages en cours... (quelques secondes)');
      
      setTimeout(async () => {
        await refreshCaches();
        console.log(`[READY] Bot prêt. ${cachedGroups.size} groupes actifs, ${cachedAdmins.size} admins.`);
      }, 2000);
    }

    if (connection === 'close') {
      // Correction JavaScript pur : suppression du casting TypeScript `as Boom`
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      console.log(`[DISCONNECTED] Déconnecté, code: ${statusCode}`);
      if (statusCode !== DisconnectReason.loggedOut) {
        console.log('[RECONNECT] Tentative de reconnexion dans 5 secondes...');
        setTimeout(startSock, 5000);
      } else {
        console.log('[RECONNECT] Déconnecté volontairement, arrêt.');
      }
    }
  });

  // Événement : sauvegarde des creds
  sock.ev.on('creds.update', saveCreds);

  // Événement : messages reçus
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    for (const msg of messages) {
      await handleIncomingMessage(sock, msg);
    }
  });

  return sock;
}

// =========================================================================
// 7. XP BATCHING
// =========================================================================
let pendingXP = new Map();

async function flushPendingXP() {
  if (!pool || pendingXP.size === 0) return;
  const batch = pendingXP;
  pendingXP = new Map();
  console.log(`[XP FLUSH] ${batch.size} entrées`);
  for (const [key, count] of batch) {
    const [groupJid, phoneNumber] = key.split('|');
    try {
      const res = await queryWithTimeout(
        `UPDATE users SET xp = xp + $1, level = floor((xp + $1)/500)+1 WHERE phone_number = $2 RETURNING xp`,
        [count, phoneNumber]
      );
      if (res.rowCount > 0) {
        console.log(`[XP SAVE] +${count} pour ${phoneNumber} (total ${res.rows[0].xp})`);
      } else {
        console.warn(`[XP SAVE] ${phoneNumber} non enregistré`);
      }
    } catch (err) {
      console.error(`[XP ERROR] ${phoneNumber}:`, err.message);
      pendingXP.set(key, (pendingXP.get(key) || 0) + count);
    }
  }
}
setInterval(flushPendingXP, 60 * 1000);

// =========================================================================
// 8. TRAITEMENT DES MESSAGES
// =========================================================================
async function handleIncomingMessage(sockInstance, msg) {
  const from = msg.key.remoteJid;
  const author = msg.key.participant || from;
  const body = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
  console.log(`[RAW MSG] from=${from} | author=${author} | body="${body.slice(0, 60)}"`);

  // Déduplication
  const msgId = msg.key.id;
  if (msgId && processingMessages.has(msgId)) {
    console.log('[DEDUP] Message déjà traité, ignoré');
    return;
  }
  if (msgId) processingMessages.add(msgId);
  if (processingMessages.size > 10000) {
    const toDelete = [...processingMessages].slice(0, 5000);
    toDelete.forEach(id => processingMessages.delete(id));
  }

  if (!from.endsWith('@g.us')) {
    console.log('[SKIP] Pas un groupe');
    return;
  }

  if (msg.key.fromMe && !body.startsWith('/')) {
    console.log('[SKIP] Message du bot non-commande');
    return;
  }

  if (body.startsWith('/')) {
    await handleCommand(sockInstance, msg, from, body);
    return;
  }

  if (!cachedGroups.has(from)) {
    console.log(`[SKIP] Groupe ${from} non activé`);
    return;
  }
  if (!pool) return;

  const authorNumber = numberFromJid(author);
  const key = `${from}|${authorNumber}`;
  pendingXP.set(key, (pendingXP.get(key) || 0) + XP_PER_MESSAGE);
  console.log(`[XP QUEUE] +1 pour ${authorNumber} (attente: ${pendingXP.get(key)})`);
}

// =========================================================================
// 9. COMMANDES
// =========================================================================
async function handleCommand(sockInstance, msg, chatJid, body) {
  const [raw, ...args] = body.split(/\s+/);
  const command = raw.toLowerCase();
  const sender = msg.key.participant || msg.key.remoteJid;
  const senderNumber = numberFromJid(sender);

  console.log(`[CMD] ${command} de ${senderNumber}`);

  const reply = async (text) => {
    await sockInstance.sendMessage(chatJid, { text }, { quoted: msg });
  };

  if (command === '/jid') {
    console.log(`[JID CMD] ${chatJid}`);
    await reply(`L'ID de ce chat est :\n\`${chatJid}\``);
    return;
  }

  if (!pool) {
    await reply('Base de données indisponible.');
    return;
  }

  switch (command) {
    case '/id':
      await reply(`ID groupe : ${chatJid}`);
      break;

    case '/activer-groupe':
      if (!BOT_NUMBER || senderNumber !== BOT_NUMBER) {
        console.log(`[ACCÈS REFUSÉ] ${senderNumber} a tenté /activer-groupe (BOT=${BOT_NUMBER})`);
        await reply('Seul le numéro du bot peut activer un groupe.');
        return;
      }
      if (cachedGroups.has(chatJid)) {
        await reply('Déjà activé.');
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
        await reply(`Groupe activé (${cachedGroups.size}/${MAX_GROUPS}).`);
      } catch (err) {
        console.error('[DB ERROR] /activer-groupe:', err.message);
        await reply('Erreur DB.');
      }
      break;

    case '/desactiver-groupe':
      if (!BOT_NUMBER || senderNumber !== BOT_NUMBER) {
        console.log(`[ACCÈS REFUSÉ] ${senderNumber} a tenté /desactiver-groupe`);
        await reply('Seul le numéro du bot peut désactiver.');
        return;
      }
      try {
        await queryWithTimeout('DELETE FROM authorized_groups WHERE group_jid = $1', [chatJid]);
        cachedGroups.delete(chatJid);
        await reply('Groupe désactivé.');
      } catch (err) {
        console.error('[DB ERROR] /desactiver-groupe:', err.message);
        await reply('Erreur DB.');
      }
      break;

    case '/addxp':
    case '/removexp': {
      if (!isBotAdmin(senderNumber)) {
        console.log(`[DENIED] ${senderNumber} non admin`);
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
          `UPDATE users SET xp = GREATEST(0, xp + $1),
            level = floor(GREATEST(0, xp + $1)/500)+1
           WHERE phone_number = $2 RETURNING *`,
          [delta, targetNumber]
        );
        if (result.rows.length === 0) {
          await reply('Membre non enregistré.');
          return;
        }
        const member = result.rows[0];
        const verb = command === '/addxp' ? 'ajouté' : 'retiré';
        await reply(
          `L'admin vient de ${verb} ${amount} XP à ${member.username || targetNumber} (total: ${member.xp} XP)`
        );
      } catch (err) {
        console.error(`[DB ERROR] ${command}:`, err.message);
        await reply('Erreur DB.');
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
        console.error('[DB ERROR] /add-admin:', err.message);
        await reply('Erreur DB.');
      }
      break;

    case '/remove-admin':
      if (!isSuperAdminNumber(senderNumber)) {
        await reply('Seul un Super Admin peut faire cela.');
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
        console.error('[DB ERROR] /remove-admin:', err.message);
        await reply('Erreur DB.');
      }
      break;

    case '/xp': {
      const target = await resolveTargetNumber(msg);
      try {
        const res = await queryWithTimeout('SELECT * FROM users WHERE phone_number = $1', [target]);
        if (res.rows.length === 0) {
          await reply('Membre non enregistré.');
          return;
        }
        const m = res.rows[0];
        await reply(`${m.username} : ${m.xp} XP (niveau ${m.level})`);
      } catch (err) {
        console.error('[DB ERROR] /xp:', err.message);
        await reply('Erreur DB.');
      }
      break;
    }

    case '/top':
    case '/leaderboard': {
      try {
        const res = await queryWithTimeout('SELECT * FROM users ORDER BY xp DESC LIMIT 20');
        if (res.rows.length === 0) {
          await reply('Aucun membre.');
          return;
        }
        const lines = res.rows.map((m, i) => {
          const medal = MEDALS[i] || `#${i+1}`;
          return `${medal} ${m.username} - ${m.xp} XP`;
        });
        await reply(`Classement XP\n\n${lines.join('\n')}`);
      } catch (err) {
        console.error('[DB ERROR] /top:', err.message);
        await reply('Erreur DB.');
      }
      break;
    }

    default:
      console.log('[CMD] Inconnue:', command);
  }
}

// =========================================================================
// 10. DÉMARRAGE
// =========================================================================
console.log('[BOOT] Démarrage du bot avec Baileys...');
startSock().then(() => {
  console.log('[BOOT] Socket Baileys initialisé.');
}).catch(err => {
  console.error('[BOOT] Erreur lors du démarrage de Baileys:', err);
});

// =========================================================================
// 11. GESTION DES ERREURS ET ARRÊT
// =========================================================================
process.on('unhandledRejection', reason => console.error('Unhandled Rejection:', reason));
process.on('uncaughtException', err => console.error('Uncaught Exception:', err));

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[SHUTDOWN] ${signal} reçu`);
  await flushPendingXP();
  if (pool) await pool.end();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));