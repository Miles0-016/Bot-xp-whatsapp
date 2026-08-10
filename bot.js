/**
 * bot.js - Bot WhatsApp XP avec Système de Séquences, Églises & Commandes Avancées (Baileys + RAM 1 min)
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
const cron = require('node-cron');

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

const MAX_GROUPS = 20;
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
    res.send('<html><body style="background:#0f172a;color:#4ade80;display:flex;justify-content:center;align-items:center;height:100vh;"><h2>✅ Bot en ligne 24h/24 (RAM Nettoyée & Séquences Actives)</h2></body></html>');
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
// 3. BASE DE DONNÉES SUPABASE & INITIALISATION DES TABLES DE SÉQUENCES
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

// Fonction d'initialisation des tables additionnelles pour les mécaniques du bot
async function initDatabaseTables() {
  if (!pool) return;
  try {
    // S'assure que la table users possède les colonnes nécessaires + is_godmode
    await queryWithTimeout(`
      CREATE TABLE IF NOT EXISTS users (
        phone_number VARCHAR(50) PRIMARY KEY,
        username VARCHAR(100) NOT NULL,
        xp INT DEFAULT 0,
        level INT DEFAULT 1,
        success_points INT DEFAULT 0,
        victory_points INT DEFAULT 0,
        fakegod_until TIMESTAMP NULL,
        fakegod_church VARCHAR(100) NULL,
        def_active BOOLEAN DEFAULT FALSE,
        boost_until TIMESTAMP NULL,
        is_godmode BOOLEAN DEFAULT FALSE
      )
    `);

    // Table des Églises (Séquence 6 - Berger)
    await queryWithTimeout(`
      CREATE TABLE IF NOT EXISTS churches (
        id SERIAL PRIMARY KEY,
        church_name VARCHAR(100) UNIQUE NOT NULL,
        leader_number VARCHAR(50) NOT NULL
      )
    `);

    // Table d'association Membres <-> Église
    await queryWithTimeout(`
      CREATE TABLE IF NOT EXISTS church_members (
        phone_number VARCHAR(50) PRIMARY KEY,
        church_name VARCHAR(100) NOT NULL
      )
    `);

    // Table de surveillance /espionnage (Séquence 4 & 3)
    await queryWithTimeout(`
      CREATE TABLE IF NOT EXISTS surveil_targets (
        watcher_number VARCHAR(50) PRIMARY KEY,
        target_number VARCHAR(50) NOT NULL
      )
    `);

    logger.info('✅ [DB] Tables additionnelles pour les séquences initialisées avec succès.');
  } catch (err) {
    logger.error({ err }, '❌ [DB] Erreur lors de l’initialisation des tables de séquences');
  }
}
setTimeout(initDatabaseTables, 3000);

// =========================================================================
// 4. LOGIQUE DE CALCUL DE SÉQUENCE SELON LE BARÈME
// =========================================================================
function getSequenceFromXP(xp) {
  if (xp >= 11000) return { seq: 3, name: 'Oracle' };
  if (xp >= 10000) return { seq: 4, name: "Sage de l'Histoire" };
  if (xp >= 6000)  return { seq: 5, name: 'Demi-Dieu' };
  if (xp >= 3000)  return { seq: 6, name: 'Berger' };
  if (xp >= 1500)  return { seq: 7, name: 'Magicien' };
  if (xp >= 500)   return { seq: 8, name: 'Brigand' };
  return { seq: 9, name: 'Maraudeur' };
}

// Messages d'accueil / IB pour les Séquences
const SEQUENCE_9_IB_MESSAGE = `🕯️ **[Brume et Destinée] Le voile se lève sur votre initiation...**

*Le gaz des réverbères de Backlund vacille, et les murmures de la nuit vous enveloppent.* Votre âme s'éveille enfin au véritable visage du monde, loin des illusions des gens ordinaires.

Vous franchissez le seuil de l'Ordre occulte en tant que :
🎯 **Séquence 9 : Maraudeur (Point de départ)**

* **Votre statut dans les ténèbres :** Vous êtes le néophyte, le tout premier échelon de la Voie. Vos mains sont encore vides, mais votre potentiel est infini. 
* **Ce que vous pouvez accomplir dans le monde occulte :**
  * *Trouver votre foi et votre salut (Commande \`/join <nom de l'eglise>\`) :* Vous pouvez utiliser cette commande pour prêter allégeance et rejoindre l'Église du Créateur (ou toute autre église fondée par de puissants Seigneurs des arcanes) afin d'implorer sa protection et de trouver refuge dans les ténèbres.
  * *Tisser votre fil d'existence :* Chaque prière, chaque offrande et chaque présence au sein de la communauté fait résonner votre esprit dans le brouillard, vous accordant de quoi grandir.
* **Votre fardeau et votre menace (Le pouvoir du Brigand) :** Ne baissez jamais la garde. En tant que Maraudeur, vous êtes la cible biologique et directe des **Séquences 8 (Brigand)**. 
  * *Comment fonctionne leur vol ?* Si un Brigand remporte une activité au sein du groupe et qu'il y a des Séquences 9 (vous) présentes, il active sa compétence de prédation. Il dispose alors d'un **délai strict de 24 heures** pour utiliser la commande de vol et désigner sa cible.
  * *La sentence :* S'il jette son dévolu sur vous, il vous dérobera net **20% de votre XP total** accumulé. C'est le prix cruel de votre faiblesse initiale et le danger permanent qui pèse sur vos épaules tant que vous n'aurez pas gravi les échelons vers des séquences plus hautes pour vous protéger.

*« Dans ce monde, tout a un prix... et votre voyage ne fait que commencer. »*`;

const SEQUENCE_8_IB_MESSAGE = `🕯️ **[Ombres et Poudre] Le masque du Brigand se pose sur votre visage...**

*La lueur blafarde des lanternes à gaz éclaire les pavés humides de Backlund. Votre première métamorphose s'achève, et l'instinct de la prédation commence à couler dans vos veines.*

Vous franchissez un nouveau palier dans la hiérarchie des ténèbres :
🎯 **Séquence 8 : Brigand**

* **Votre statut et votre nature :** Vous n'êtes plus le simple novice sans défense qui tremble dans les ruelles. Vous avez acquired l'audace, la ruse et la force brutale nécessaires pour survivre aux lois impitoyables de la nuit.
* **Votre pouvoir occulte et votre menace (La prédation des XP) :**
  * *La chasse aux Séquences 9 :* En tant que Brigand, vous possédez le droit et la puissance de traquer les plus faibles. Si vous remportez une activité au sein du groupe et que des **Séquences 9 (Maraudeur)** s'y trouvent, votre nature de prédateur s'éveille.
  * *La règle du vol (Commande \`/steal [@cible]\`) :* Vous disposez d'un **délai strict de 24 heures** après l'événement pour utiliser la commande de vol et désigner votre cible de Séquence 9. 
  * *Le tribut :* Si elle n'est pas protégée par la magie d'un Magicien, vous lui arracherez net **20% de son XP total**, alimentant ainsi votre propre ascension vers les sommets tout en maintenant les novices sous votre emprise.
* **Le revers de la médaille :** Ne pavanez pas trop vite. Si vous régnez sur les Maraudeurs, vous restez vous-même une proie potentielle pour les échelons supérieurs qui guettent vos moindres faux pas.

*« Dans la Voie du Maraudeur, la force ne se demande pas, elle se prend de force. »*`;

const SEQUENCE_7_IB_MESSAGE = `🕯️ **[Illusion et Mystification] Le voile de la Séquence 7 se déchire...**[cite: 3]

*Les projecteurs s'éteignent sur les simples larcins de la rue. Vous entrez dans le domaine de l'inexplicable, là où le réel se plie à votre volonté et où chaque geste devient un tour de force magique.*[cite: 3]

Vous franchissez un nouveau palier dans la hiérarchie occulte :[cite: 3]
🎯 **Séquence 7 : Magicien**[cite: 3]

* **Votre statut et votre nature :** Vous maîtrisez désormais l'art subtil de la tromperie cosmique et des **sorts** élémentaires. Vos mains ne servent plus seulement à prendre, mais à manipuler l'espace, à dérober l'invisible et à ériger des barrières impénétrables.[cite: 3]
* **Vos pouvoirs occultes et vos nouvelles prérogatives :**[cite: 3]
  * *La Protection des Faibles (Commande \`/def [@cible]\`) :* En tant que Magicien, vous pouvez tisser un bouclier protecteur autour d'un Maraudeur (Séquence 9) pour le soustraire aux convoitises des Brigands. Ce rituel exige le sacrifice de **100 XP** de votre part, mais il annule instantanément le vol de la cible, la protégeant ainsi de manière **active**.[cite: 3]
  * *La Chasse aux Faux Dieux (Commande \`/catch [@cible]\`) :* Votre regard perçoit les supercheries les plus hautes. Si un Demi-Dieu (Séquence 5) active son pouvoir de \`/fakegod\`, vous pouvez surgir sur lui en dépensant **100 XP** pour perturber son rituel et lui arracher net **200 XP** en guise de trophée.[cite: 3]
* **Le prix de la magie :** Le monde occulte ne fait pas de cadeaux. Vos **sorts** exigent des sacrifices d'énergie, et un mauvais calcul vous exposera aux représailles de ceux que vous tentez de manipuler.[cite: 3]

*« Dans le grand théâtre des arcanes, le spectateur applaudit, mais le Magicien tire les ficelles. »*[cite: 3]`;

const SEQUENCE_6_IB_MESSAGE = `🕯️ **[Foi et Troupeau] Les portes de l'Église s'ouvrent à votre voix...**

*Le murmure des fidèles résonne dans la pénombre de la cathédrale. Vous ne cherchez plus seulement à survivre ou à tromper l'illusion, vous apprenez à guider, à unir et à rassembler.*

Vous franchissez un nouveau palier dans la hiérarchie occulte :
🎯 **Séquence 6 : Berger**

* **Votre statut et votre nature :** Vous devenez le pôle d'une communauté. Vos paroles ont du poids, et votre aura attire les âmes égarées en quête de protection et de sens dans ce monde chaotique. Vous n'êtes cependant **pas obligé de fonder une église** : vous pouvez choisir de rester un électron libre tout en endossant votre rôle de Berger.
* **Vos pouvoirs occultes et vos nouvelles prérogatives :**
  * *Fonder une Communauté (Commande \`/creat <nom_de_l'eglise>\`) :* Si vous le désirez, vous avez la légitimité sacrée de fonder votre propre Église sous ce nom pour devenir le guide spirituel de ce sanctuaire.
  * *Le Prélèvement de la Dîme :* Si vous fondez ou dirigez une église, tous les fidèles de Séquence 9 (Maraudeurs) qui la rejoignent par la commande \`/join\` vous font bénéficier automatiquement d'une **dîme de 10%** sur l'XP qu'ils gagnent passivement.
  * *La Protection des Adeptes (Commande \`/def\`) :* Vous avez désormais accès à la compétence de défense sur vos adeptes. En faisant le sacrifice d'**1 point de victoire**, vous pouvez protéger simultanément **3 personnes** de votre choix.
* **Le fardeau du pasteur :** Un Berger sans fidèles est un roi sans royaume, mais certains préfèrent la route solitaire. À vous de choisir votre voie.

*« Le monde est un désert ténébreux, et le Berger est le seul à détenir la lanterne qui rassemble les brebis égarées. »*`;

const SEQUENCE_5_IB_MESSAGE = `🕯️ **[Divinité et Apothéose] Le voile de la mortalité se brise...**

*Une lueur céleste et terrifiante émane de votre être. Vous franchissez la ligne invisible qui sépare les simples mortels des entités dignes d'être vénérées. Vous touchez du doigt le pouvoir des anciens dieux.*

Vous accédez au sommet des arcanes :
🎯 **Séquence 5 : Demi-Dieu**

* **Votre statut et votre nature :** Vous n'êtes plus un simple pratiquant de la magie ou un meneur d'hommes. Votre présence modifie l'tissu même du réel. Vous incarnez une puissance que l'on prie et que l'on redoute.
* **Vos pouvoirs occultes et vos nouvelles prérogatives :**
  * *L'Usurpation Céleste (Commande \`/fakegod <nom_de_l'eglise>\`) :* En dépensant **1 point de succès**, vous pouvez jeter votre dévolu sur une église existante et vous proclamer son **Faux Dieu** pendant 24 heures. Durant ce laps de temps, tous les gains d'XP des membres de cette église sont redirigés directement vers vous, court-circuitant le Berger officiel.
  * *La Puissance Absolue :* Votre influence grandit, et votre nom devient synonyme de légende au sein des classements du monde occulte.
* **Le danger de l'hubris :** Incarner un faux dieu attire l'œil perçant des **Séquences 7 (Magiciens)**. S'ils découvrent votre supercherie, ils pourront utiliser leur sort de \`/catch\` pour vous traquer, vous affliger un lourd tribut en XP et perturber votre divinité usurpée.

*« Mortels, inclinez-vous... car le divin marche désormais parmi vous. »*`;

const SEQUENCE_4_IB_MESSAGE = `🕯️ **[Histoire et Vestiges] Le grand livre des âges s'ouvre devant vous...**

*Les murmures du passé ne sont plus de simples échos lointains, mais des outils tangibles entre vos mains. Vous apprenez à invoquer les ombres de l'histoire et à percer les secrets les plus enfouis.*

Vous accédez aux strates supérieures du savoir : 🎯 **Séquence 4 : Sage de l'Histoire**

* **Votre statut et votre nature :** Vous devenez un pilier incontournable du monde occulte. Votre regard traverse les époques et vous tenez entre vos mains les fils invisibles qui dépendent des factions rivales.
* **Vos pouvoirs occultes et vos nouvelles prérogatives :**
  * *La Révélation des Âges (Commande \`/s [@membre]\`) :* En sacrifiant **1 point de victoire**, vous pouvez mettre à nu et présenter publiquement la séquence actuelle de n'importe quel membre.
  * *L'Œil de l'Historien (Commande \`/show [@demi-dieu]\`) :* Vous jetez votre dévolu sur un Demi-Dieu (Séquence 5) pour suivre ses moindres faits et gestes : vous recevez une notification en message privé (IB) pour chaque action qu'il entreprend.
  * *La contrainte du lien :* Votre cible ne peut être choisie qu'une seule fois pour toute votre durée dans cette séquence. Si vous souhaitez espionner un autre individu, vous subirez un contrecoup sévère et votre score sera réinitialisé au niveau minimal de la Séquence 4.
* **Le fardeau de la mémoire :** Porter le poids de l'histoire exige une vigilance de tous les instants. Vos décisions pèsent lourdement sur la balance du destin, car dans votre sillage, chaque vestige devient une arme.`;

// =========================================================================
// 5. CACHES MÉMOIRE & NETTOYAGE RAM STRICT (TOUTES LES 1 MIN)
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

// --- NETTOYAGE AGRESSIF DE LA RAM & GESTION DES DÎMES / FAKEGOD (Toutes les 1 min) ---
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
            const userRes = await queryWithTimeout('SELECT xp, boost_until, is_godmode FROM users WHERE phone_number = $1', [phoneNumber]);
            if (userRes.rows.length === 0) continue;
            
            let finalCount = count;
            const uData = userRes.rows[0];
            const oldSeq = uData.is_godmode ? 3 : getSequenceFromXP(uData.xp).seq;

            const hasBoost = uData.boost_until && new Date(uData.boost_until) > new Date();
            if (hasBoost) {
              finalCount = count + (count * 2);
            }

            const newXpTotal = uData.xp + finalCount;
            const newLevel = Math.floor(newXpTotal / 500) + 1;
            const newSeq = uData.is_godmode ? 3 : getSequenceFromXP(newXpTotal).seq;

            await queryWithTimeout(
              `UPDATE users SET xp = $2, level = $3 WHERE phone_number = $1`,
              [phoneNumber, newXpTotal, newLevel]
            );

            // Si l'utilisateur progresse de séquence et n'est pas en GodMode
            if (!uData.is_godmode) {
              if (oldSeq > 8 && newSeq <= 8) {
                try { await sock.sendMessage(`${phoneNumber}@s.whatsapp.net`, { text: SEQUENCE_8_IB_MESSAGE }); } catch (ibErr) {}
              }
              if (oldSeq > 7 && newSeq <= 7) {
                try { await sock.sendMessage(`${phoneNumber}@s.whatsapp.net`, { text: SEQUENCE_7_IB_MESSAGE }); } catch (ibErr) {}
              }
              if (oldSeq > 6 && newSeq <= 6) {
                try { await sock.sendMessage(`${phoneNumber}@s.whatsapp.net`, { text: SEQUENCE_6_IB_MESSAGE }); } catch (ibErr) {}
              }
              if (oldSeq > 5 && newSeq <= 5) {
                try { await sock.sendMessage(`${phoneNumber}@s.whatsapp.net`, { text: SEQUENCE_5_IB_MESSAGE }); } catch (ibErr) {}
              }
              if (oldSeq > 4 && newSeq <= 4) {
                try { await sock.sendMessage(`${phoneNumber}@s.whatsapp.net`, { text: SEQUENCE_4_IB_MESSAGE }); } catch (ibErr) {}
              }
            }

            // Gestion de la dîme (Séquence 6 - Berger)
            const churchMemRes = await queryWithTimeout('SELECT church_name FROM church_members WHERE phone_number = $1', [phoneNumber]);
            if (churchMemRes.rows.length > 0) {
              const churchName = churchMemRes.rows[0].church_name;
              const churchLeaderRes = await queryWithTimeout('SELECT leader_number FROM churches WHERE church_name = $1', [churchName]);
              if (churchLeaderRes.rows.length > 0) {
                const leaderNum = churchLeaderRes.rows[0].leader_number;
                if (leaderNum !== phoneNumber) {
                  const tithe = Math.floor(finalCount / 10);
                  if (tithe > 0) {
                    await queryWithTimeout('UPDATE users SET xp = xp + $2 WHERE phone_number = $1', [leaderNum, tithe]);
                  }
                }
              }
            }

            // Gestion de /fakegod (Séquence 5)
            const churchNameForFake = churchMemRes.rows.length > 0 ? churchMemRes.rows[0].church_name : null;
            if (churchNameForFake) {
              const fakeGodRes = await queryWithTimeout(
                "SELECT phone_number FROM users WHERE fakegod_church = $1 AND fakegod_until > NOW()",
                [churchNameForFake]
              );
              if (fakeGodRes.rows.length > 0) {
                const fakeGodNum = fakeGodRes.rows[0].phone_number;
                if (fakeGodNum !== phoneNumber) {
                  await queryWithTimeout('UPDATE users SET xp = xp + $2 WHERE phone_number = $1', [fakeGodNum, finalCount]);
                }
              }
            }

          } catch (e) {}
        }
        logger.info('💾 [RAM CLEANER] Données XP et dîmes flushées et purgées de la RAM.');
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
// 6. KEEP-ALIVE & WATCHDOG & TÂCHES PLANIFIÉES (CRON CLASSEMENT COMPLET)
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

// Classement complet à minuit et midi
cron.schedule('0 0,12 * * *', async () => {
  if (!sock || isReconnecting) return;
  try {
    const groupsRes = await queryWithTimeout('SELECT group_jid FROM authorized_groups');
    if (!groupsRes || groupsRes.rows.length === 0) return;

    const topRes = await queryWithTimeout('SELECT phone_number, username, xp, level, is_godmode FROM users ORDER BY xp DESC');
    if (!topRes || topRes.rows.length === 0) return;

    let message = `🏆 *CLASSEMENT COMPLET DES MEMBRES* 🏆\n\n`;
    const mentions = [];

    topRes.rows.forEach((m, i) => {
      const medal = MEDALS[i] || `🔹`;
      const userJid = `${m.phone_number}@s.whatsapp.net`;
      mentions.push(userJid);
      const seqTag = m.is_godmode ? '[Détenteur de toutes les Séquences 👑]' : `(Séquence ${getSequenceFromXP(m.xp).seq})`;
      message += `${medal} *${i + 1}.* ${m.username} (*${m.xp} XP* - Niv. ${m.level}) ${seqTag}\n`;
    });

    for (const g of groupsRes.rows) {
      try {
        await sock.sendMessage(g.group_jid, { text: message, mentions });
      } catch (err) {}
    }
  } catch (err) {}
});

// =========================================================================
// 7. PERMISSIONS ET UTILITAIRES DE NUMÉRO
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
// 8. AUTHENTIFICATION BAILEYS STOCKÉE DANS SUPABASE (PERSISTANCE RENDER)
// =========================================================================
async function useSupabaseAuthState() {
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
      const data = JSON.parse(res.rows.rows ? res.rows[0].session_data : res.rows[0].session_data, (_, val) => {
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
    saveCreds: () => writeData(creds, 'creds')
  };
}

// =========================================================================
// 9. SOCKET WHATSAPP
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
// 10. TRAITEMENT DES MESSAGES & INTERCEPTION DES COMMANDES SURVEILLÉES
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
    const authorNumber = numberFromJid(author);

    // Notification IB pour Sage de l'Histoire (Seq 4) et Oracle (Seq 3)
    if (pool && authorNumber && body.startsWith('/')) {
      const watchersRes = await queryWithTimeout('SELECT watcher_number FROM surveil_targets WHERE target_number = $1', [authorNumber]);
      if (watchersRes.rows.length > 0) {
        for (const w of watchersRes.rows) {
          const watcherJid = `${w.watcher_number}@s.whatsapp.net`;
          try {
            await sockInstance.sendMessage(watcherJid, { text: `🚨 [Renseignement] La cible surveillée @${authorNumber} a exécuté la commande : \`${body}\`` });
          } catch (e) {}
        }
      }
    }

    if (msg.key.fromMe && !body.startsWith('/')) return;

    if (body.startsWith('/')) {
      await handleCommand(sockInstance, msg, from, body);
      return;
    }

    if (!cachedGroups.has(from)) return;
    if (!pool) return;

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
// 11. COMMANDES & GESTION DES COMPÉTENCES DE SÉQUENCE
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

  const isBot = BOT_NUMBER && senderNumber === BOT_NUMBER;
  const isSuper = isSuperAdminNumber(senderNumber);
  const isAdmin = isBotAdmin(senderNumber);

  // Récupération des données de l'expéditeur en BDD
  let senderData = null;
  try {
    const sRes = await queryWithTimeout('SELECT * FROM users WHERE phone_number = $1', [senderNumber]);
    if (sRes.rows.length > 0) senderData = sRes.rows[0];
  } catch (e) {}

  const isGodMode = senderData?.is_godmode || false;
  const senderSeq = isGodMode ? 3 : (senderData ? getSequenceFromXP(senderData.xp).seq : 9);

  switch (command) {
    case '/menu': {
      let helpText = `📜 *MENU DU BOT*

👤 *MEMBRES & STATS*
🔹 */xp [@membre]* : Affiche le niveau/XP.
🔹 */sign <pseudo> [@membre]* : S'inscrire ou inscrire un membre.
🔹 */top* : Classement complet de tous les membres.
🔹 */mycmds* : Afficher les commandes accessibles à votre Séquence.
ℹ️ */id* ou */jid* : Afficher l'identifiant du groupe.

⚡ *COMPÉTENCES DE SÉQUENCE*
🔹 */join <nom_eglise>* : (Seq 9 Maraudeur) Rejoindre une église.
🔹 */steal [@cible]* : (Seq 8 Brigand) Voler 20% d'XP à un Maraudeur (sous 24h).
🔹 */def [@cible]* : (Seq 7 Magicien) Protéger un Maraudeur (Coût : 100 XP) OU (Seq 6 Berger) Protéger 3 adeptes (Coût : 1 Point de Victoire).
🔹 */catch [@cible]* : (Seq 7 Magicien) Attraper un Demi-Dieu (Coût : 100 XP, Gain : 200 XP).
🔹 */creat <nom>* : (Seq 6 Berger) Fonder une communauté (facultatif).
🔹 */fakegod <nom_eglise>* : (Seq 5 Demi-Dieu) Devenir le faux dieu d'une église (Nécessite 1 pt succès).
🔹 */s [@cible]* : (Seq 4/3 Sage/Oracle) Surveiller un utilisateur (Coût : 1 pt victoire).
🔹 */show [@cible]* : (Seq 4 Sage) Contrôler le Demi-Dieu cible.
🔹 */win [@cible] [montant]* : (Admin) Attribuer des points de victoire.`;

      if (isAdmin) {
        helpText += `\n\n🛠️ *ADMINISTRATEURS BOT*
🔸 */addxp @membre <montant>* : Ajouter de l'XP.
🔸 */removexp @membre <montant>* : Retirer de l'XP.`;
      }

      if (isSuper || isBot) {
        helpText += `\n\n🔑 *SUPER ADMINS / GESTION*
⚡ */godmode @membre* : Octroyer TOUTES les séquences simultanément à un membre.
⚡ */activer-groupe* : Activer le système d'XP.
⚡ */desactiver-groupe* : Désactiver le système d'XP.
⚡ */set-ping-group* : Définir ce groupe pour l'auto-ping.
⚡ */add-admin @membre* : Ajouter un Admin Bot.
⚡ */remove-admin @membre* : Retirer un Admin Bot.`;
      }

      await reply(helpText);
      break;
    }

    // --- COMMANDE SPECIAL /godmode OU /god (Super Admin uniquement) ---
    case '/godmode':
    case '/god': {
      if (!isSuper && !isBot) {
        await reply('⚡ Accès strictement réservé au Super Admin.');
        return;
      }
      const targetNum = await resolveTargetNumber(msg);
      if (!targetNum) {
        await reply('Utilisation : /godmode <@membre>');
        return;
      }

      try {
        await queryWithTimeout(`
          INSERT INTO users (phone_number, username, xp, level, is_godmode)
          VALUES ($1, $2, 12000, 25, TRUE)
          ON CONFLICT (phone_number) 
          DO UPDATE SET is_godmode = TRUE, xp = GREATEST(users.xp, 12000)
        `, [targetNum, `Omnipotent_${targetNum}`]);

        const targetJid = `${targetNum}@s.whatsapp.net`;

        // Envoi simultané de TOUS les messages de bienvenue/initiation des séquences
        await replyIB(targetJid, `👑 **[OMNIPOTENCE ABSOLUE] Vous avez reçu le GOD MODE !**\n\nVous êtes désormais le seul à posséder **SIMULTANÉMENT TOUTES LES SÉQUENCES** (Séquence 9 à Séquence 3) et l'accès à l'intégralité des pouvoirs occultes du monde !`);
        
        await replyIB(targetJid, SEQUENCE_9_IB_MESSAGE);
        await replyIB(targetJid, SEQUENCE_8_IB_MESSAGE);
        await replyIB(targetJid, SEQUENCE_7_IB_MESSAGE);
        await replyIB(targetJid, SEQUENCE_6_IB_MESSAGE);
        await replyIB(targetJid, SEQUENCE_5_IB_MESSAGE);
        await replyIB(targetJid, SEQUENCE_4_IB_MESSAGE);

        await reply(`✨ **[LÉGENDE COSAQUE]** @${targetNum} est désormais investi de **TOUTES LES SÉQUENCES SIMULTANÉMENT** ! Toutes les compétences occultes lui sont ouvertes et les rituels d'initiation ont été transmis en privé.`);
      } catch (err) {
        await reply('Erreur lors de l’attribution du God Mode.');
      }
      break;
    }

    // --- COMMANDE SPECIAL /mycmds (Voir les commandes débloquées selon sa séquence) ---
    case '/mycmds':
    case '/mycommands': {
      if (!senderData) {
        await reply('Vous devez d’abord vous inscrire via `/sign <pseudo>` pour connaître vos compétences.');
        return;
      }

      let text = `📜 *VOS COMMANDES ET POUVOIRS ACTUELS*\n`;
      if (isGodMode) {
        text += `👑 **Statut : SOUVERAIN (Toutes les Séquences débloquées)**\n\n` +
                `🔹 */join <nom_eglise>* : Rejoindre une église.\n` +
                `🔹 */steal [@cible]* : Voler 20% d'XP à un Maraudeur (Seq 9).\n` +
                `🔹 */def [@cible]* : Protéger un Maraudeur (Seq 9) OU 3 adeptes.\n` +
                `🔹 */catch [@cible]* : Intercepter et dépouiller un Demi-Dieu.\n` +
                `🔹 */creat <nom>* : Fonder votre propre église.\n` +
                `🔹 */fakegod <nom_eglise>* : Usurper le contrôle d'une église.\n` +
                `🔹 */s [@cible]* : Surveiller les actions d'un membre.\n` +
                `🔹 */show [@cible]* : Prendre le contrôle d'un Demi-Dieu.`;
      } else {
        const seqInfo = getSequenceFromXP(senderData.xp);
        text += `🎯 **Votre Séquence : Séquence ${seqInfo.seq} (${seqInfo.name})**\n\n`;
        text += `🔹 */join <nom_eglise>* : Rejoindre une église d'un Berger.\n`;

        if (seqInfo.seq <= 8) {
          text += `🔹 */steal [@cible]* : (Seq 8 Brigand) Voler 20% d'XP à un Maraudeur (Seq 9).\n`;
        }
        if (seqInfo.seq <= 7) {
          text += `🔹 */def [@cible]* : (Seq 7 Magicien) Protéger un Maraudeur (Coût : 100 XP).\n`;
          text += `🔹 */catch [@cible]* : (Seq 7 Magicien) Intercepter un Demi-Dieu en /fakegod (Gagne 200 XP).\n`;
        }
        if (seqInfo.seq <= 6) {
          text += `🔹 */creat <nom>* : (Seq 6 Berger) Fonder votre propre église.\n`;
          text += `🔹 */def [@cible1 @cible2 @cible3]* : (Seq 6 Berger) Protéger 3 adeptes (Coût : 1 Pt Victoire).\n`;
        }
        if (seqInfo.seq <= 5) {
          text += `🔹 */fakegod <nom_eglise>* : (Seq 5 Demi-Dieu) Rediriger l'XP d'une église vers vous (Coût : 1 Pt Succès).\n`;
        }
        if (seqInfo.seq <= 4) {
          text += `🔹 */s [@cible]* : (Seq 4 Sage) Surveiller les commandes d'une cible (Coût : 1 Pt Victoire).\n`;
          text += `🔹 */show [@cible]* : (Seq 4 Sage) Prendre le contrôle d'un Demi-Dieu.\n`;
        }
      }

      await reply(text);
      break;
    }

    // --- COMMANDE /join (Séquence 9 : Maraudeur - Rejoindre une église) ---
    case '/join': {
      const churchName = args.join(' ').trim();
      if (!churchName) {
        await reply('Utilisation : /join <Nom de l’Église>');
        return;
      }
      try {
        const churchRes = await queryWithTimeout('SELECT * FROM churches WHERE church_name = $1', [churchName]);
        if (churchRes.rows.length === 0) {
          await reply('Cette église n’existe pas dans les arcanes.');
          return;
        }

        await queryWithTimeout(
          `INSERT INTO church_members (phone_number, church_name) VALUES ($1, $2)
           ON CONFLICT (phone_number) DO UPDATE SET church_name = EXCLUDED.church_name`,
          [senderNumber, churchName]
        );

        await reply(`⛪ Vous avez rejoint avec succès l'église "${churchName}" ! Votre foi est désormais liée à ses fidèles et à son Berger.`);
      } catch (err) {
        await reply('Erreur lors de la liaison avec l’église.');
      }
      break;
    }

    // --- COMMANDE /steal (Séquence 8 : Brigand) ---
    case '/steal': {
      if (senderSeq > 8 && !isGodMode && !isAdmin && !isSuper) {
        await reply('Accès refusé. Réservé aux Séquences 8 (Brigand) et supérieures.');
        return;
      }
      const targetNum = await resolveTargetNumber(msg);
      if (!targetNum || targetNum === senderNumber) {
        await reply('Veuillez cibler un Maraudeur valide.');
        return;
      }

      try {
        const targetRes = await queryWithTimeout('SELECT * FROM users WHERE phone_number = $1', [targetNum]);
        if (targetRes.rows.length === 0) {
          await reply('Cible introuvable dans la base de données.');
          return;
        }
        const targetUser = targetRes.rows[0];
        const targetSeq = targetUser.is_godmode ? 3 : getSequenceFromXP(targetUser.xp).seq;

        if (targetSeq !== 9) {
          await reply('Le Brigand ne peut cibler que des Séquences 9 (Maraudeur).');
          return;
        }

        if (targetUser.def_active) {
          await reply(`🛡️ Échec ! Ce Maraudeur est protégé par un Magicien ou un Berger via \`/def\`.`);
          await queryWithTimeout('UPDATE users SET def_active = FALSE WHERE phone_number = $1', [targetNum]);
          return;
        }

        const stolenXp = Math.floor(targetUser.xp * 0.20);
        if (stolenXp <= 0) {
          await reply('La cible n’a pas assez d’XP à voler.');
          return;
        }

        await queryWithTimeout('UPDATE users SET xp = xp - $1, level = floor((xp - $1)/500)+1 WHERE phone_number = $2', [stolenXp, targetNum]);
        await queryWithTimeout('UPDATE users SET xp = xp + $1, level = floor((xp + $1)/500)+1 WHERE phone_number = $2', [stolenXp, senderNumber]);

        await reply(`🦹 Vol réussi ! Vous avez dérobé ${stolenXp} XP (20%) au Maraudeur @${targetNum}.`);
      } catch (err) {
        await reply('Erreur lors de l’exécution du vol.');
      }
      break;
    }

    // --- COMMANDE /def (Séquence 7 : Magicien / Séquence 6 : Berger) ---
    case '/def': {
      if (senderSeq > 7 && !isGodMode && !isAdmin && !isSuper) {
        await reply('Accès refusé. Réservé aux Séquences 7 (Magicien), Séquences 6 (Berger) et supérieures.');
        return;
      }

      // Si l'expéditeur est un Berger (Seq 6), il sacrifie 1 point de victoire pour protéger 3 personnes
      if (senderSeq === 6 && !isGodMode) {
        if (!senderData || senderData.victory_points < 1) {
          await reply('⚠️ En tant que Berger, vous devez sacrifier 1 point de victoire pour utiliser /def et protéger 3 personnes, mais vous n’en avez pas assez.');
          return;
        }

        const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
        let targetsToProtect = [];
        if (contextInfo && contextInfo.mentionedJid && contextInfo.mentionedJid.length > 0) {
          targetsToProtect = contextInfo.mentionedJid.map(j => numberFromJid(j)).slice(0, 3);
        }

        if (targetsToProtect.length === 0) {
          await reply('Veuillez mentionner jusqu’à 3 adeptes à protéger avec /def.');
          return;
        }

        try {
          await queryWithTimeout('UPDATE users SET victory_points = victory_points - 1 WHERE phone_number = $1', [senderNumber]);
          for (const tNum of targetsToProtect) {
            await queryWithTimeout('UPDATE users SET def_active = TRUE WHERE phone_number = $1', [tNum]);
          }
          await reply(`🛡️ Protection divine de Berger activée pour ${targetsToProtect.length} adepte(s) (Coût : 1 Point de Victoire).`);
        } catch (err) {
          await reply('Erreur lors de l’activation de la défense du Berger.');
        }
        break;
      }

      // Cas standard pour le Magicien (Seq 7) ou GodMode : Coût 100 XP pour 1 cible
      if (!isGodMode && (!senderData || senderData.xp < 100)) {
        await reply('Vous devez sacrifier 100 XP pour utiliser /def, mais vous n’en avez pas assez.');
        return;
      }

      const targetNum = await resolveTargetNumber(msg);
      if (!targetNum) {
        await reply('Veuillez cibler un Maraudeur à protéger.');
        return;
      }

      try {
        const targetRes = await queryWithTimeout('SELECT * FROM users WHERE phone_number = $1', [targetNum]);
        if (targetRes.rows.length === 0) {
          await reply('Cible introuvable.');
          return;
        }
        const targetUser = targetRes.rows[0];
        const tSeq = targetUser.is_godmode ? 3 : getSequenceFromXP(targetUser.xp).seq;

        if (tSeq !== 9) {
          await reply('Vous ne pouvez protéger qu’un utilisateur de Séquence 9 (Maraudeur).');
          return;
        }

        if (!isGodMode) {
          await queryWithTimeout('UPDATE users SET xp = xp - 100, level = floor((xp - 100)/500)+1 WHERE phone_number = $1', [senderNumber]);
        }
        await queryWithTimeout('UPDATE users SET def_active = TRUE WHERE phone_number = $1', [targetNum]);

        await reply(`🛡️ Protection magique activée pour le Maraudeur @${targetNum} !`);
      } catch (err) {
        await reply('Erreur lors de l’activation de /def.');
      }
      break;
    }

    // --- COMMANDE /catch (Séquence 7 : Magicien) ---
    case '/catch': {
      if (senderSeq > 7 && !isGodMode && !isAdmin && !isSuper) {
        await reply('Accès refusé. Réservé aux Séquences 7 (Magicien) et supérieures.');
        return;
      }
      if (!isGodMode && (!senderData || senderData.xp < 100)) {
        await reply('Il vous faut au moins 100 XP à sacrifier pour lancer /catch.');
        return;
      }

      const targetNum = await resolveTargetNumber(msg);
      if (!targetNum) {
        await reply('Veuillez cibler un Demi-Dieu.');
        return;
      }

      try {
        const targetRes = await queryWithTimeout('SELECT * FROM users WHERE phone_number = $1', [targetNum]);
        if (targetRes.rows.length === 0) {
          await reply('Cible introuvable.');
          return;
        }
        const targetUser = targetRes.rows[0];
        const tSeq = targetUser.is_godmode ? 3 : getSequenceFromXP(targetUser.xp).seq;

        if (tSeq !== 5) {
          await reply('La cible n’est pas un Demi-Dieu (Séquence 5).');
          return;
        }

        if (!targetUser.fakegod_church) {
          await reply('Ce Demi-Dieu n’est actuellement pas en train d’utiliser /fakegod dans une église.');
          return;
        }

        if (!isGodMode) {
          await queryWithTimeout('UPDATE users SET xp = xp - 100 + 200, level = floor((xp - 100 + 200)/500)+1 WHERE phone_number = $1', [senderNumber]);
        }
        await queryWithTimeout('UPDATE users SET xp = GREATEST(0, xp - 200), level = floor(GREATEST(0, xp - 200)/500)+1 WHERE phone_number = $1', [targetNum]);

        await reply(`🎯 Piégé ! Vous avez intercepté le Demi-Dieu @${targetNum} en train d'utiliser /fakegod : vous lui dérobez 200 XP.`);
      } catch (err) {
        await reply('Erreur lors de l’exécution de /catch.');
      }
      break;
    }

    // --- COMMANDE /creat (Séquence 6 : Berger) ---
    case '/creat': {
      if (senderSeq > 6 && !isGodMode && !isAdmin && !isSuper) {
        await reply('Accès refusé. Réservé aux Séquences 6 (Berger) et supérieures.');
        return;
      }
      const churchName = args.join(' ').trim();
      if (!churchName) {
        await reply('Utilisation : /creat <Nom de l’Église>');
        return;
      }

      try {
        const existing = await queryWithTimeout('SELECT * FROM churches WHERE leader_number = $1', [senderNumber]);
        if (existing.rows.length > 0) {
          await reply('Vous possédez déjà une église.');
          return;
        }

        await queryWithTimeout('INSERT INTO churches (church_name, leader_number) VALUES ($1, $2)', [churchName, senderNumber]);
        await queryWithTimeout('INSERT INTO church_members (phone_number, church_name) VALUES ($1, $2) ON CONFLICT (phone_number) DO UPDATE SET church_name = EXCLUDED.church_name', [senderNumber, churchName]);

        await reply(`⛪ Église "${churchName}" fondée avec succès ! En tant que Berger, vous guidez désormais ce sanctuaire.`);
      } catch (err) {
        await reply('Erreur : Ce nom d’église est déjà pris ou une erreur est survenue.');
      }
      break;
    }

    // --- COMMANDE /fakegod (Séquence 5 : Demi-Dieu) ---
    case '/fakegod': {
      if (senderSeq > 5 && !isGodMode && !isAdmin && !isSuper) {
        await reply('Accès refusé. Réservé aux Séquences 5 (Demi-Dieu) et supérieures.');
        return;
      }
      const churchName = args.join(' ').trim();
      if (!churchName) {
        await reply('Utilisation : /fakegod <Nom de l’Église>');
        return;
      }

      if (!isGodMode && (!senderData || senderData.success_points < 1)) {
        await reply('⚠️ Vous devez posséder au moins 1 point de succès en réserve pour utiliser /fakegod.');
        return;
      }

      try {
        const churchRes = await queryWithTimeout('SELECT * FROM churches WHERE church_name = $1', [churchName]);
        if (churchRes.rows.length === 0) {
          await reply('Cette église n’existe pas.');
          return;
        }

        if (!isGodMode) {
          await queryWithTimeout('UPDATE users SET success_points = success_points - 1 WHERE phone_number = $1', [senderNumber]);
        }
        await queryWithTimeout('UPDATE users SET fakegod_until = NOW() + INTERVAL \'24 hours\', fakegod_church = $2 WHERE phone_number = $1', [senderNumber, churchName]);

        await reply(`✨ Vous incarnez désormais le faux dieu de l'église "${churchName}" pendant 24 heures ! Vous percevrez tous les XP de messages des membres de cette église.`);
      } catch (err) {
        await reply('Erreur lors de l’activation de /fakegod.');
      }
      break;
    }

    // --- COMMANDE /win (Attribution de points de victoire par Admin) ---
    case '/win': {
      if (!isAdmin && !isSuper) {
        await reply('Accès refusé. Réservé aux administrateurs.');
        return;
      }
      const targetNum = await resolveTargetNumber(msg);
      if (!targetNum) {
        await reply('Utilisation : /win <@membre> [montant]');
        return;
      }
      const customAmount = parseInt(args.find(a => /^\d+$/.test(a)), 10);
      const rewardXP = customAmount && customAmount > 0 ? customAmount : 200;

      try {
        await queryWithTimeout('UPDATE users SET victory_points = victory_points + 1, xp = xp + $1, level = floor((xp + $1)/500)+1 WHERE phone_number = $2', [rewardXP, targetNum]);
        await reply(`🏆 Point de victoire attribué à @${targetNum} avec une récompense de ${rewardXP} XP !`);
      } catch (err) {
        await reply('Erreur DB lors de l’attribution de la victoire.');
      }
      break;
    }

    // --- COMMANDE /s (Séquence 4 / 3 : Sage de l'Histoire & Oracle) ---
    case '/s': {
      if (senderSeq > 4 && !isGodMode && !isAdmin && !isSuper) {
        await reply('Accès refusé. Réservé aux Séquences 4 et supérieures.');
        return;
      }
      const targetNum = await resolveTargetNumber(msg);
      if (!targetNum) {
        await reply('Utilisation : /s <@membre>');
        return;
      }

      if (!isGodMode && senderData.victory_points < 1) {
        await reply('⚠️ Vous devez dépenser 1 point de victoire pour utiliser la surveillance /s.');
        return;
      }

      try {
        const targetRes = await queryWithTimeout('SELECT * FROM users WHERE phone_number = $1', [targetNum]);
        if (targetRes.rows.length === 0) {
          await reply('Cible introuvable.');
          return;
        }
        const targetUser = targetRes.rows[0];
        const targetSeqInfo = targetUser.is_godmode ? { seq: 'TOUTES (GodMode)', name: 'Omnipotent' } : getSequenceFromXP(targetUser.xp);

        if (!isGodMode) {
          await queryWithTimeout('UPDATE users SET victory_points = victory_points - 1 WHERE phone_number = $1', [senderNumber]);
        }
        await queryWithTimeout('INSERT INTO surveil_targets (watcher_number, target_number) VALUES ($1, $2) ON CONFLICT (watcher_number) DO UPDATE SET target_number = EXCLUDED.target_number', [senderNumber, targetNum]);

        await reply(`👁️ Surveillance active établie sur @${targetNum}.\n📜 Séquence de la cible : Séquence ${targetSeqInfo.seq} (${targetSeqInfo.name}).`);
      } catch (err) {
        await reply('Erreur lors de la mise en place de la surveillance.');
      }
      break;
    }

    // --- COMMANDE /show (Séquence 4 : Sage de l'Histoire) ---
    case '/show': {
      if (senderSeq > 4 && !isGodMode && !isAdmin && !isSuper) {
        await reply('Accès refusé. Réservé aux Séquences 4 et supérieures.');
        return;
      }
      const targetNum = await resolveTargetNumber(msg);
      if (!targetNum) {
        await reply('Utilisation : /show <@demi-dieu>');
        return;
      }

      try {
        const targetRes = await queryWithTimeout('SELECT * FROM users WHERE phone_number = $1', [targetNum]);
        if (targetRes.rows.length === 0) {
          await reply('Cible introuvable.');
          return;
        }
        const tSeq = targetRes.rows[0].is_godmode ? 3 : getSequenceFromXP(targetRes.rows[0].xp).seq;
        if (tSeq !== 5 && !targetRes.rows[0].is_godmode) {
          await reply('La cible doit être un Demi-Dieu (Séquence 5).');
          return;
        }

        await reply(`🔮 [Sage de l'Histoire] Vous prenez le contrôle direct des actions du Demi-Dieu @${targetNum} pour cette session.`);
      } catch (err) {
        await reply('Erreur lors de l’exécution de /show.');
      }
      break;
    }

    case '/id':
      await reply(`ID groupe : ${chatJid}`);
      break;

    case '/activer-groupe': {
      if (!isBot && !isSuper && !isBotAdmin(senderNumber)) {
        await reply(`Accès refusé. Réservé aux administrateurs.`);
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
      if (!isBot && !isSuper && !isBotAdmin(senderNumber)) {
        await reply('Accès refusé. Réservé aux administrateurs.');
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
        await reply(`✅ Ce groupe a été défini avec succès comme cible pour l'auto-ping anti-inactivité.`);
      } catch (err) {
        await reply('Erreur lors de l\'enregistrement du groupe de ping.');
      }
      break;
    }

    case '/addxp':
    case '/removexp': {
      if (!isBot && !isSuper && !isBotAdmin(senderNumber)) {
        await reply('Accès refusé.');
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
        const uCheck = await queryWithTimeout('SELECT xp, is_godmode FROM users WHERE phone_number = $1', [targetNumber]);
        const isTargetGod = uCheck.rows.length > 0 ? uCheck.rows[0].is_godmode : false;
        const oldSeq = isTargetGod ? 3 : (uCheck.rows.length > 0 ? getSequenceFromXP(uCheck.rows[0].xp).seq : 9);

        const result = await queryWithTimeout(
          `UPDATE users 
           SET xp = GREATEST(0, xp + $2),
               level = floor(GREATEST(0, xp + $2)/500) + 1
           WHERE phone_number = $1
           RETURNING *`,
          [targetNumber, delta]
        );
        
        if (result.rowCount === 0) {
          await reply(`⚠️ @${targetNumber} n'est pas encore inscrit.`);
          return;
        }

        const member = result.rows[0];
        const newSeq = isTargetGod ? 3 : getSequenceFromXP(member.xp).seq;

        if (!isTargetGod) {
          if (oldSeq > 8 && newSeq <= 8) {
            try { await sockInstance.sendMessage(`${targetNumber}@s.whatsapp.net`, { text: SEQUENCE_8_IB_MESSAGE }); } catch (ibErr) {}
          }
          if (oldSeq > 7 && newSeq <= 7) {
            try { await sockInstance.sendMessage(`${targetNumber}@s.whatsapp.net`, { text: SEQUENCE_7_IB_MESSAGE }); } catch (ibErr) {}
          }
          if (oldSeq > 6 && newSeq <= 6) {
            try { await sockInstance.sendMessage(`${targetNumber}@s.whatsapp.net`, { text: SEQUENCE_6_IB_MESSAGE }); } catch (ibErr) {}
          }
          if (oldSeq > 5 && newSeq <= 5) {
            try { await sockInstance.sendMessage(`${targetNumber}@s.whatsapp.net`, { text: SEQUENCE_5_IB_MESSAGE }); } catch (ibErr) {}
          }
          if (oldSeq > 4 && newSeq <= 4) {
            try { await sockInstance.sendMessage(`${targetNumber}@s.whatsapp.net`, { text: SEQUENCE_4_IB_MESSAGE }); } catch (ibErr) {}
          }
        }

        const verb = command === '/addxp' ? 'ajouté' : 'retiré';
        await reply(
          `L'administrateur vient de ${verb} ${amount} XP à ${member.username} (@${targetNumber}) (total: ${member.xp} XP)`
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
        if (!isBot && !isSuper && !isBotAdmin(senderNumber)) {
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
        
        try {
          await sockInstance.sendMessage(`${targetNumber}@s.whatsapp.net`, { text: SEQUENCE_9_IB_MESSAGE });
        } catch (ibErr) {}

        await reply(`✅ Enregistrement réussi !\n👤 **Membre** : @${member.phone_number}\n🏷️ **Pseudo** : ${member.username}\n✨ **XP** : ${member.xp} | **Niveau** : ${member.level}\n*(Le message d'initiation de la Séquence 9 a été envoyé en message privé).*`);
      } catch (err) {
        await reply('Erreur lors de l’inscription en BDD.');
      }
      break;
    }

    case '/add-admin':
      if (!isBot && !isSuper && !isSuperAdminNumber(senderNumber)) {
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
      if (!isBot && !isSuper && !isSuperAdminNumber(senderNumber)) {
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
        const seqStatus = m.is_godmode ? '👑 GOD MODE (Toutes Séquences)' : `Séquence ${getSequenceFromXP(m.xp).seq} (${getSequenceFromXP(m.xp).name})`;
        await reply(`👤 **${m.username}** (@${m.phone_number})\n✨ **XP** : ${m.xp}\n📊 **Niveau** : ${m.level}\n📜 **Séquence** : ${seqStatus}`);
      } catch (err) {
        await reply('Erreur DB lors de la récupération de l’XP.');
      }
      break;
    }

    case '/top':
    case '/leaderboard': {
      try {
        const res = await queryWithTimeout('SELECT * FROM users ORDER BY xp DESC');
        if (res.rows.length === 0) {
          await reply('Aucun membre inscrit pour le moment.');
          return;
        }
        const lines = res.rows.map((m, i) => {
          const medal = MEDALS[i] || `#${i+1}`;
          const tag = m.is_godmode ? '👑 [GodMode]' : `(Seq ${getSequenceFromXP(m.xp).seq})`;
          return `${medal} ${m.username} - ${m.xp} XP (Niv. ${m.level}) ${tag}`;
        });
        const mentions = res.rows.map(m => `${m.phone_number}@s.whatsapp.net`);
        await sockInstance.sendMessage(chatJid, { text: `🏆 Classement XP 🏆\n\n${lines.join('\n')}`, mentions }, { quoted: msg });
      } catch (err) {
        await reply('Erreur DB.');
      }
      break;
    }

    default:
      break;
  }
}

// Fonction d'aide pour l'envoi direct IB
async function replyIB(targetJid, text) {
  try {
    if (sock) {
      await sock.sendMessage(targetJid, { text });
    }
  } catch (err) {}
}

// =========================================================================
// 12. DÉMARRAGE ET ARRÊT PROPRE
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