/**
 * bot.js - Bot WhatsApp de gestion d'XP (connecté à Supabase)
 * 
 * - Authentification par QR code (affiché sur la page web)
 * - Session persistante (LocalAuth + disque Render)
 * - XP credite par lot toutes les 60s (comptage en memoire), groupes actifs,
 *   membres deja enregistres uniquement
 * - Commandes : /activer-groupe, /desactiver-groupe (numero du bot uniquement),
 *               /addxp, /removexp, /add-admin, /remove-admin, /xp, /top
 * - Stratégie anti-gel : timeouts stricts, gestionnaire d'erreurs, reconnexion automatique
 * - Serveur Express pour afficher le QR code sur la page web
 */

const path = require('path');
const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const { Pool } = require('pg');
const QRCode = require('qrcode'); // <-- installé avec `npm install qrcode`

// ---------------------------------------------------------------------------
// CONFIGURATION
// ---------------------------------------------------------------------------

const MAX_GROUPS = 5;
const XP_PER_MESSAGE = 1;
const MEDALS = ['🥇', '🥈', '🥉'];

// Super-admins (format "2376xxxxxxxx", séparés par des virgules)
const SUPER_ADMIN_NUMBERS = (process.env.SUPER_ADMIN_NUMBERS || '')
  .split(',')
  .map((n) => n.trim())
  .filter(Boolean);

if (SUPER_ADMIN_NUMBERS.length === 0) {
  console.warn(
    "ATTENTION : SUPER_ADMIN_NUMBERS est vide. Personne ne pourra utiliser /add-admin. " +
      "Définis cette variable d'environnement avec au moins un numéro (ex: 2376xxxxxxxx)."
  );
}

// QR code actif (stocké en base64 pour affichage web)
let currentQRCodeBase64 = null;

// ---------------------------------------------------------------------------
// CONNEXION SUPABASE
// ---------------------------------------------------------------------------

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

if (!pool) {
  console.error(
    "DATABASE_URL absente : le bot ne peut pas fonctionner sans Supabase (source unique de vérité pour l'XP)."
  );
} else {
  pool.on('error', (err) => {
    console.error('Erreur inattendue du pool PostgreSQL (connexion inactive) :', err.message);
  });
}

/**
 * Exécute une requête avec un timeout global de 6 secondes.
 * Logge systématiquement la requête envoyée, son résultat, et toute erreur -
 * couvre automatiquement TOUS les points d'appel du fichier.
 */
function queryWithTimeout(text, params) {
  const shortText = text.replace(/\s+/g, ' ').trim().slice(0, 140);
  console.log(`[DB QUERY] ${shortText}${params ? ' | params=' + JSON.stringify(params) : ''}`);

  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Timeout requête Supabase (6s dépassés).')), 6000)
  );

  return Promise.race([pool.query(text, params), timeout])
    .then((result) => {
      console.log(`[DB QUERY OK] ${shortText} -> ${result.rowCount ?? result.rows?.length ?? 0} ligne(s) affectée(s)`);
      return result;
    })
    .catch((err) => {
      console.error(`[DB ERROR] Échec de la requête "${shortText}" :`, err.stack || err.message);
      throw err;
    });
}

function computeLevel(xp) {
  return Math.floor((Number(xp) || 0) / 500) + 1;
}

// ---------------------------------------------------------------------------
// CACHES EN MÉMOIRE
// ---------------------------------------------------------------------------

let cachedGroups = new Map(); // group_jid -> group_name
let cachedAdmins = new Set(); // phone_number

async function refreshCaches() {
  if (!pool) {
    console.warn('[CACHE] Pas de pool Supabase, impossible de rafraîchir les caches.');
    return;
  }
  try {
    const groupsResult = await queryWithTimeout('SELECT group_jid, group_name FROM authorized_groups');
    cachedGroups = new Map(groupsResult.rows.map((r) => [r.group_jid, r.group_name]));

    const adminsResult = await queryWithTimeout('SELECT phone_number FROM bot_admins');
    cachedAdmins = new Set(adminsResult.rows.map((r) => r.phone_number));

    console.log(`[CACHE] Rafraîchi : ${cachedGroups.size} groupe(s) actif(s), ${cachedAdmins.size} admin(s) bot.`);
  } catch (err) {
    console.error('[CACHE] Rechargement échoué, on garde la version précédente :', err.stack || err.message);
  }
}

// ---------------------------------------------------------------------------
// PERMISSIONS ET MENTIONS
// ---------------------------------------------------------------------------

function numberFromJid(jid) {
  return (jid || '').split('@')[0];
}

// Retourne le numero de l'auteur d'un message de maniere fiable, y compris
// pour les messages envoyes par le compte du bot lui-meme (fromMe: true),
// cas ou `msg.author` n'est pas renseigne par whatsapp-web.js.
function senderNumberFromMsg(msg) {
  if (msg.fromMe) return BOT_NUMBER || numberFromJid(msg.from);
  return numberFromJid(msg.author || msg.from);
}

function isSuperAdminNumber(number) {
  return SUPER_ADMIN_NUMBERS.includes(number);
}

function isBotAdmin(number) {
  return isSuperAdminNumber(number) || cachedAdmins.has(number);
}

async function resolveTargetNumber(msg) {
  const mentions = await msg.getMentions();
  if (mentions && mentions.length > 0) {
    return numberFromJid(mentions[0].id._serialized);
  }
  return senderNumberFromMsg(msg);
}

// ---------------------------------------------------------------------------
// CLIENT WHATSAPP
// ---------------------------------------------------------------------------

const CHROME_PATH_WINDOWS = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const isWindows = process.platform === 'win32';
const executablePath =
  process.env.PUPPETEER_EXECUTABLE_PATH || (isWindows ? CHROME_PATH_WINDOWS : undefined);

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: path.join(__dirname, '.wwebjs_auth') }),
  puppeteer: {
    executablePath,
    // Volontairement SANS --single-process : ce flag fusionne navigateur et
    // rendu dans un seul process, ce qui peut geler silencieusement sous
    // Docker avec peu de RAM - exactement le symptôme signalé. Les autres
    // flags ci-dessous sont sûrs et couramment recommandés en environnement
    // headless/serveur.
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu',
    ],
  },
});

/**
 * Événement 'qr' : génère un QR code et le stocke en base64 pour l'afficher sur la page web.
 */
client.on('qr', async (qr) => {
  console.log('[QR] Nouveau QR code reçu de whatsapp-web.js, génération de l\'image...');
  try {
    currentQRCodeBase64 = await QRCode.toDataURL(qr);
    console.log('[QR] QR code prêt, disponible sur la page web (GET /).');
  } catch (err) {
    console.error('[QR] Erreur lors de la génération de l\'image QR code :', err.stack || err.message);
    currentQRCodeBase64 = null;
  }
});

client.on('authenticated', () => {
  currentQRCodeBase64 = null; // plus besoin du QR une fois authentifié
  console.log('[AUTH] Authentification WhatsApp réussie. Session en cours de sauvegarde (LocalAuth).');
});

// Numéro WhatsApp du compte auquel le bot est connecté (rempli après 'ready').
// Nécessaire car pour un message envoyé par ce compte lui-même (fromMe: true),
// `msg.author` n'est PAS renseigné par whatsapp-web.js — s'appuyer dessus
// donnerait un numéro incorrect (voir senderNumberFromMsg plus bas).
let BOT_NUMBER = null;

client.on('ready', async () => {
  currentQRCodeBase64 = null;
  BOT_NUMBER = client.info?.wid?.user || null;
  console.log(`[READY] Client WhatsApp prêt. JID complet : ${client.info?.wid?._serialized || 'inconnu'} | Numéro détecté : ${BOT_NUMBER || 'AUCUN (probleme ?)'}`);
  await refreshCaches();
  console.log(
    `[READY] Bot XP WhatsApp opérationnel. Groupes actifs : ${cachedGroups.size}/${MAX_GROUPS}. Admins bot : ${cachedAdmins.size}.`
  );
});

client.on('auth_failure', (msg) => {
  console.error('[AUTH_ERROR] Échec de l\'authentification WhatsApp :', msg);
  currentQRCodeBase64 = null;
  // Le client émettra peut-être un nouveau QR après un délai.
});

let reconnecting = false;
client.on('disconnected', (reason) => {
  console.warn(`[DISCONNECTED] Client WhatsApp déconnecté. Raison : ${reason}`);
  if (reconnecting) {
    console.log('[RECONNECT] Une tentative de reconnexion est déjà en cours, on ignore ce nouvel évènement.');
    return;
  }
  reconnecting = true;
  setTimeout(async () => {
    try {
      console.log('[RECONNECT] Tentative de reconnexion en cours...');
      await client.initialize();
      console.log('[RECONNECT] client.initialize() relancé sans exception.');
    } catch (err) {
      console.error('[RECONNECT] Reconnexion échouée, nouvel essai dans 15s :', err.stack || err.message);
    } finally {
      reconnecting = false;
    }
  }, 15000);
});

// Rafraîchissement périodique des caches (groupes/admins)
setInterval(refreshCaches, 60 * 1000);

// ---------------------------------------------------------------------------
// COMPTAGE PAR LOT DE L'XP (remplace le credit immediat par message)
// ---------------------------------------------------------------------------
// Plutot que d'ecrire dans Supabase a chaque message (potentiellement des
// centaines de requetes par minute sur un groupe actif), on compte en memoire
// combien de messages chaque numero a envoye, puis on envoie UNE requete par
// numero toutes les 60s. Le total d'XP credite est identique, seule la
// latence d'ecriture change (jusqu'a 60s de decalage) - largement acceptable
// pour un systeme d'XP, et ca reduit la charge sur Supabase dans les memes
// proportions que le "depouillement" imagine a l'origine, sans avoir besoin
// d'un composant supplementaire pour le faire.
let pendingXP = new Map(); // cle `${groupJid}|${phoneNumber}` -> nombre de messages depuis le dernier envoi

async function flushPendingXP() {
  if (!pool || pendingXP.size === 0) return;

  // On "ferme" le lot courant et on repart sur une Map vide immediatement :
  // les nouveaux messages qui arrivent pendant l'envoi du lot precedent
  // s'accumulent deja dans le lot suivant, sans rien perdre ni bloquer.
  const batch = pendingXP;
  pendingXP = new Map();
  console.log(`[XP FLUSH] Envoi du lot XP : ${batch.size} numéro(s)/groupe(s) à mettre à jour.`);

  for (const [key, count] of batch.entries()) {
    const [groupJid, phoneNumber] = key.split('|');
    try {
      // WHERE phone_number = $2 ne touche que les lignes existantes : un
      // numero absent de `users` n'affecte simplement aucune ligne (pas de
      // creation automatique de membre).
      const result = await queryWithTimeout(
        `UPDATE users
         SET xp = xp + $1,
             level = floor((xp + $1) / 500) + 1
         WHERE phone_number = $2
         RETURNING xp`,
        [count, phoneNumber]
      );
      if (result.rowCount > 0) {
        console.log(`[XP SAVE] +${count} XP attribué à ${phoneNumber} dans le groupe ${groupJid} (total désormais : ${result.rows[0].xp} XP)`);
      } else {
        console.warn(`[XP SAVE] ${phoneNumber} a envoyé ${count} message(s) dans ${groupJid} mais n'est pas enregistré dans \`users\` : ignoré.`);
      }
    } catch (err) {
      console.error(`[DB ERROR] Crédit XP par lot échoué pour ${phoneNumber} (+${count}) dans ${groupJid} :`, err.stack || err.message);
      // On remet le decompte en attente pour ne pas le perdre au prochain essai.
      pendingXP.set(key, (pendingXP.get(key) || 0) + count);
    }
  }
}

setInterval(flushPendingXP, 60 * 1000);

// ---------------------------------------------------------------------------
// TRAITEMENT DES MESSAGES (version Claude)
// ---------------------------------------------------------------------------
// Un seul listener ('message_create', nécessaire pour capter les commandes
// envoyées depuis le numéro du bot lui-même - voir historique du projet).
// La vérification de groupe est synchrone (`msg.from.endsWith('@g.us')`) :
// getChat() n'est appelé QUE pour les commandes, jamais pour le flux normal
// de messages qui sert au crédit XP. Ça réduit d'un facteur important le
// nombre d'allers-retours avec Chrome sur le chemin le plus emprunté.
client.on('message_create', async (msg) => {
  // Log synchrone, absolument rien avant lui : si cette ligne n'apparaît
  // JAMAIS dans les logs Render pour un message envoyé dans un groupe, c'est
  // que l'évènement ne se déclenche pas du tout côté whatsapp-web.js (à
  // creuser côté version de la librairie / webVersionCache - voir README).
  console.log(`[RAW MSG DETECTED] from=${msg.from} fromMe=${msg.fromMe} id=${msg.id?._serialized || 'inconnu'} body="${(msg.body || '').slice(0, 60)}"`);

  try {
    if (!msg.from || !msg.from.endsWith('@g.us')) {
      console.log(`[INCOMING] Ignoré : ${msg.from} n'est pas un groupe (vérification synchrone).`);
      return;
    }

    const body = (msg.body || '').trim();

    if (msg.fromMe && !body.startsWith('/')) {
      console.log("[INCOMING] Ignoré : message envoyé par le bot lui-même et ce n'est pas une commande.");
      return;
    }

    if (body.startsWith('/')) {
      // getChat() reservé aux commandes (rares comparées au flux de messages).
      const chat = await msg.getChat();
      await handleCommand(msg, chat, body);
      return;
    }

    const groupJid = msg.from; // JID du groupe directement depuis le message, sans appel Chrome
    if (!cachedGroups.has(groupJid)) {
      console.log(`[INCOMING] Ignoré : le groupe ${groupJid} n'est pas dans la liste des groupes actifs (${cachedGroups.size} actif(s) actuellement).`);
      return;
    }
    if (!pool) return;

    const authorNumber = senderNumberFromMsg(msg);
    const key = `${groupJid}|${authorNumber}`;
    pendingXP.set(key, (pendingXP.get(key) || 0) + XP_PER_MESSAGE);
    console.log(`[XP QUEUE] +${XP_PER_MESSAGE} XP en attente pour ${authorNumber} dans ${groupJid} (envoyé au prochain lot, sous 60s).`);
  } catch (err) {
    console.error('[MSG ERROR] Erreur de traitement du message :', err.stack || err.message);
  }
});

// Battement de vie régulier : distingue "le process Node est bloqué/mort" de
// "le process tourne mais whatsapp-web.js ne reçoit plus rien" - si ce log
// continue d'apparaître alors que plus aucun [RAW MSG DETECTED] n'arrive,
// le problème est confirmé côté session/librairie WhatsApp, pas côté Node.
setInterval(() => {
  console.log(
    `[HEARTBEAT] Bot vivant. Groupes actifs : ${cachedGroups.size}/${MAX_GROUPS}. ` +
      `Admins bot : ${cachedAdmins.size}. XP en attente : ${pendingXP.size}.`
  );
}, 5 * 60 * 1000);

// ---------------------------------------------------------------------------
// COMMANDES
// ---------------------------------------------------------------------------

function reject(msg, senderNumber, command, superAdminOnly = false) {
  console.warn(`[DENIED] Utilisateur ${senderNumber} non autorisé pour ${command}${superAdminOnly ? ' (réservé Super Admin)' : ''}`);
  return msg.reply(
    superAdminOnly
      ? 'Seul un Super Admin (numéro autorisé) peut utiliser cette commande.'
      : "Tu n'es pas autorisé à utiliser cette commande."
  );
}

async function handleCommand(msg, chat, body) {
  const [rawCommand, ...args] = body.split(/\s+/);
  const command = rawCommand.toLowerCase();
  const senderNumber = senderNumberFromMsg(msg);

  console.log(`[CMD] Commande ${command} reçue de ${senderNumber} dans ${chat.id._serialized} (args: ${args.join(' ') || 'aucun'})`);

  if (!pool) {
    console.error(`[CMD] Impossible de traiter ${command} : aucun pool Supabase (DATABASE_URL absente).`);
    await msg.reply("Le bot n'est pas connecté à la base de données pour le moment.");
    return;
  }

  switch (command) {
    case '/id': {
      await msg.reply(`L'ID de ce groupe est :\n\`${chat.id._serialized}\``);
      break;
    }

    case '/activer-groupe': {
      // Restriction demandee : seul le numero du bot lui-meme peut activer un
      // groupe (pas les autres admins, meme Super Admin).
      if (!BOT_NUMBER || senderNumber !== BOT_NUMBER) {
        console.warn(`[DENIED] Utilisateur ${senderNumber} non autorisé pour /activer-groupe (seul le numéro du bot "${BOT_NUMBER}" est accepté).`);
        await msg.reply('Seul le numéro du bot peut activer un groupe.');
        return;
      }

      const groupJid = chat.id._serialized;
      if (cachedGroups.has(groupJid)) {
        console.log(`[CMD] /activer-groupe : ${groupJid} est déjà dans le cache des groupes actifs, rien à faire.`);
        await msg.reply('Ce groupe est déjà activé.');
        return;
      }
      if (cachedGroups.size >= MAX_GROUPS) {
        console.warn(`[CMD] /activer-groupe refusé : limite de ${MAX_GROUPS} groupes déjà atteinte.`);
        await msg.reply(
          `Limite de ${MAX_GROUPS} groupes atteinte. ` +
            "Désactive d'abord un groupe existant avec /desactiver-groupe avant d'en ajouter un nouveau."
        );
        return;
      }

      try {
        await queryWithTimeout(
          `INSERT INTO authorized_groups (group_jid, group_name, activated_by)
           VALUES ($1, $2, $3) ON CONFLICT (group_jid) DO NOTHING`,
          [groupJid, chat.name || null, senderNumber]
        );
        cachedGroups.set(groupJid, chat.name || null);
        console.log(`[DB SUCCESS] Groupe ${groupJid} ("${chat.name || 'sans nom'}") inséré avec succès dans la table authorized_groups`);
        await msg.reply(`Groupe activé. Le suivi XP est maintenant actif ici (${cachedGroups.size}/${MAX_GROUPS}).`);
      } catch (err) {
        console.error(`[DB ERROR] Échec de l'insertion dans authorized_groups :`, err.stack || err.message);
        await msg.reply("Erreur : impossible d'activer le groupe pour le moment (Supabase indisponible).");
      }
      break;
    }

    case '/desactiver-groupe': {
      // Meme restriction que /activer-groupe : numero du bot uniquement.
      if (!BOT_NUMBER || senderNumber !== BOT_NUMBER) {
        console.warn(`[DENIED] Utilisateur ${senderNumber} non autorisé pour /desactiver-groupe (seul le numéro du bot "${BOT_NUMBER}" est accepté).`);
        await msg.reply('Seul le numéro du bot peut désactiver un groupe.');
        return;
      }

      const groupJid = chat.id._serialized;
      try {
        await queryWithTimeout('DELETE FROM authorized_groups WHERE group_jid = $1', [groupJid]);
        cachedGroups.delete(groupJid);
        console.log(`[DB SUCCESS] Groupe ${groupJid} retiré avec succès de la table authorized_groups`);
        await msg.reply(`Groupe désactivé. Le suivi XP est arrêté ici (${cachedGroups.size}/${MAX_GROUPS}).`);
      } catch (err) {
        console.error(`[DB ERROR] Échec de la suppression dans authorized_groups :`, err.stack || err.message);
        await msg.reply('Erreur : impossible de désactiver le groupe pour le moment (Supabase indisponible).');
      }
      break;
    }

    case '/addxp':
    case '/removexp': {
      if (!isBotAdmin(senderNumber)) return reject(msg, senderNumber, command);

      const amount = parseInt(args.find((a) => /^\d+$/.test(a)), 10);
      if (!amount || amount <= 0) {
        await msg.reply(`Utilisation : ${command} @membre <montant>`);
        return;
      }
      const targetNumber = await resolveTargetNumber(msg);
      const delta = command === '/addxp' ? amount : -amount;

      try {
        // Mise à jour atomique avec retour
        const result = await queryWithTimeout(
          `UPDATE users 
           SET xp = GREATEST(0, xp + $1),
               level = floor(GREATEST(0, xp + $1) / 500) + 1
           WHERE phone_number = $2
           RETURNING *`,
          [delta, targetNumber]
        );
        if (result.rows.length === 0) {
          await msg.reply("Ce membre n'est pas enregistré dans la base.");
          return;
        }
        const member = result.rows[0];
        const targetJid = `${targetNumber}@c.us`;
        const verb = command === '/addxp' ? 'ajouté' : 'retiré';
        await chat.sendMessage(
          `L'admin vient de ${verb} ${amount} XP à ${member.username || targetNumber} (total : ${member.xp} XP).`,
          { mentions: [targetJid] }
        );
      } catch (err) {
        console.error(`Erreur ${command} :`, err.message);
        await msg.reply("Erreur : impossible de modifier l'XP pour le moment (Supabase indisponible).");
      }
      break;
    }

    case '/add-admin': {
      if (!isSuperAdminNumber(senderNumber)) return reject(msg, senderNumber, command, true);

      const targetNumber = await resolveTargetNumber(msg);
      try {
        const result = await queryWithTimeout(
          'INSERT INTO bot_admins (phone_number, added_by) VALUES ($1, $2) ON CONFLICT (phone_number) DO NOTHING RETURNING phone_number',
          [targetNumber, senderNumber]
        );
        if (result.rowCount > 0) {
          cachedAdmins.add(targetNumber);
          await chat.sendMessage(`@${targetNumber} peut désormais utiliser les commandes du bot.`, {
            mentions: [`${targetNumber}@c.us`],
          });
        } else {
          await msg.reply(`@${targetNumber} est déjà administrateur.`);
        }
      } catch (err) {
        console.error('Erreur /add-admin :', err.message);
        await msg.reply("Erreur : impossible d'ajouter cet admin pour le moment (Supabase indisponible).");
      }
      break;
    }

    case '/remove-admin': {
      if (!isSuperAdminNumber(senderNumber)) return reject(msg, senderNumber, command, true);

      const targetNumber = await resolveTargetNumber(msg);
      try {
        const result = await queryWithTimeout(
          'DELETE FROM bot_admins WHERE phone_number = $1 RETURNING phone_number',
          [targetNumber]
        );
        if (result.rowCount > 0) {
          cachedAdmins.delete(targetNumber);
          await chat.sendMessage(`@${targetNumber} a perdu l'accès aux commandes du bot.`, {
            mentions: [`${targetNumber}@c.us`],
          });
        } else {
          await msg.reply(`@${targetNumber} n'est pas administrateur.`);
        }
      } catch (err) {
        console.error('Erreur /remove-admin :', err.message);
        await msg.reply('Erreur : impossible de retirer cet admin pour le moment (Supabase indisponible).');
      }
      break;
    }

    case '/xp': {
      const targetNumber = await resolveTargetNumber(msg);
      try {
        const result = await queryWithTimeout('SELECT * FROM users WHERE phone_number = $1', [targetNumber]);
        if (result.rows.length === 0) {
          await msg.reply("Ce membre n'est pas enregistré dans la base.");
          return;
        }
        const m = result.rows[0];
        await chat.sendMessage(`${m.username} : ${m.xp} XP (niveau ${m.level})`, {
          mentions: [`${targetNumber}@c.us`],
        });
      } catch (err) {
        console.error('Erreur /xp :', err.message);
        await msg.reply("Erreur : impossible de récupérer l'XP pour le moment (Supabase indisponible).");
      }
      break;
    }

    case '/top':
    case '/leaderboard': {
      try {
        const result = await queryWithTimeout('SELECT * FROM users ORDER BY xp DESC LIMIT 20');
        if (result.rows.length === 0) {
          await chat.sendMessage('Aucun membre enregistré pour le moment.');
          return;
        }
        const lines = result.rows.map((m, i) => {
          const medal = MEDALS[i] || `#${i + 1}`;
          return `${medal} ${m.username} - ${m.xp} XP`;
        });
        await chat.sendMessage(`Classement XP\n\n${lines.join('\n')}`);
      } catch (err) {
        console.error('Erreur /top :', err.message);
        await msg.reply('Erreur : classement indisponible pour le moment (Supabase indisponible).');
      }
      break;
    }

    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// SERVEUR HTTP / PAGE WEB (Render)
// ---------------------------------------------------------------------------

const healthApp = express();

healthApp.get('/', (req, res) => {
  if (currentQRCodeBase64) {
    res.send(`
      <!DOCTYPE html>
      <html lang="fr">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>QR Code Bot XP</title>
        <style>
          body { font-family: system-ui, sans-serif; background: #0f172a; color: #fff; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
          .card { background: #1e293b; padding: 2rem; border-radius: 12px; text-align: center; box-shadow: 0 4px 20px rgba(0,0,0,0.4); max-width: 400px; }
          .qr { margin: 1.5rem 0; }
          p { color: #94a3b8; line-height: 1.5; }
        </style>
      </head>
      <body>
        <div class="card">
          <h2>📱 Scanne ce QR code avec WhatsApp</h2>
          <div class="qr">
            <img src="${currentQRCodeBase64}" alt="QR Code WhatsApp" style="width: 250px; height: 250px; border-radius: 8px;">
          </div>
          <p>Ouvre WhatsApp sur ton téléphone,<br>va dans <b>Paramètres > Appareils liés</b><br>et scanne ce code.</p>
        </div>
      </body>
      </html>
    `);
  } else {
    res.send(`
      <!DOCTYPE html>
      <html lang="fr">
      <head>
        <meta charset="UTF-8">
        <title>Bot XP WhatsApp</title>
        <style>
          body { font-family: system-ui, sans-serif; background: #0f172a; color: #4ade80; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
          .card { background: #1e293b; padding: 2rem; border-radius: 12px; text-align: center; }
        </style>
      </head>
      <body>
        <div class="card">
          <h2>✅ Bot XP WhatsApp en ligne</h2>
          <p style="color: #94a3b8;">Aucun QR code en attente (session connectée ou en cours d'initialisation).</p>
        </div>
      </body>
      </html>
    `);
  }
});

healthApp.get('/health', (req, res) =>
  res.status(200).json({
    status: 'ok',
    qrAvailable: currentQRCodeBase64 !== null,
    groupesActifs: cachedGroups.size,
    adminsBot: cachedAdmins.size,
    numerosEnAttenteXP: pendingXP.size,
  })
);

healthApp.listen(process.env.PORT || 8080, () => {
  console.log(`Serveur Web HTTP démarré sur le port ${process.env.PORT || 8080}`);
});

// ---------------------------------------------------------------------------
// GESTION DES ERREURS GLOBALES
// ---------------------------------------------------------------------------

process.on('unhandledRejection', (reason) => console.error('Promesse rejetée non gérée :', reason));
process.on('uncaughtException', (err) => console.error('Exception non gérée :', err));

// ---------------------------------------------------------------------------
// FERMETURE PROPRE
// ---------------------------------------------------------------------------

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Signal ${signal} reçu, arrêt propre en cours...`);
  try {
    await flushPendingXP(); // ne pas perdre le comptage XP en cours au redémarrage
  } catch (err) {
    console.error('Erreur lors du dernier envoi du lot XP :', err.message);
  }
  try {
    await client.destroy();
  } catch (err) {
    console.error('Erreur lors de la fermeture du client WhatsApp :', err.message);
  }
  if (pool) {
    try {
      await pool.end();
    } catch (err) {
      console.error('Erreur lors de la fermeture du pool PostgreSQL :', err.message);
    }
  }
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ---------------------------------------------------------------------------
// DÉMARRAGE
// ---------------------------------------------------------------------------

console.log('[BOOT] Démarrage du bot...');
console.log(`[BOOT] DATABASE_URL : ${process.env.DATABASE_URL ? 'définie' : 'ABSENTE (probleme)'}`);
console.log(`[BOOT] SUPER_ADMIN_NUMBERS : ${SUPER_ADMIN_NUMBERS.length > 0 ? SUPER_ADMIN_NUMBERS.join(', ') : 'VIDE (probleme)'}`);
console.log(`[BOOT] PUPPETEER_EXECUTABLE_PATH : ${executablePath || '(non définie, Puppeteer utilisera son Chromium par défaut)'}`);

client.initialize();
console.log('[BOOT] client.initialize() appelé, en attente du QR code ou de la reprise de session...');