# Module 2 — Bot WhatsApp de gestion d'XP

Bot WhatsApp connecté à Supabase qui crédite automatiquement de l'XP aux membres
d'un groupe et expose des commandes d'administration (`/addxp`, `/top`, etc.).
Fait partie d'un projet en deux modules :

- **Module 1** — Dashboard Admin (Node.js/Express, déployé sur Render, gère les
  membres/groupes/comptes via une interface web, connecté à Supabase).
- **Module 2** (ce dépôt) — Bot WhatsApp (`whatsapp-web.js`), déployé sur Render,
  connecté à la **même base Supabase** que le Module 1.

Ce document décrit l'ensemble du projet suffisamment en détail pour pouvoir le
reproduire intégralement à partir de zéro, et sert de guide de mise en place.

---

## 1. Architecture générale

```
WhatsApp (groupe) ──► whatsapp-web.js (Puppeteer/Chromium headless)
                              │
                              ▼
                          bot.js (Node.js)
                              │
                  ┌───────────┼────────────┐
                  ▼           ▼            ▼
            Supabase      Cache mémoire   Serveur HTTP
           (PostgreSQL)   (groupes/admins) (QR code + healthcheck)
```

- Le bot se connecte à WhatsApp via `whatsapp-web.js`, qui pilote une session
  Chromium headless (Puppeteer) — c'est la même technique que "WhatsApp Web"
  dans un navigateur classique, automatisée.
- Toutes les données persistantes (membres, XP, groupes autorisés, admins du
  bot) vivent dans **Supabase (PostgreSQL)** — le bot ne stocke rien de durable
  en local, à l'exception de la session WhatsApp elle-même.
- Un petit serveur Express écoute sur `process.env.PORT` : il sert la page web
  affichant le QR code de connexion, et un endpoint `/health` pour Render.

## 2. Arborescence du projet

```
xp-whatsapp-bot/
├── bot.js                    # Tout le code du bot (fichier unique)
├── package.json
├── Dockerfile                # Image Docker (Chromium système + Node 18)
├── render.yaml                # Config Render (Blueprint, optionnel)
├── .gitignore
├── make-zip.js                # Regenere un ZIP livrable du projet
├── sql/
│   └── schema_module2.sql    # Tables Supabase specifiques a ce module
└── README.md                  # Ce fichier
```

Fichiers volontairement absents (retirés au fil du projet car obsolètes) :
- `groups.json` / `database.json` — remplacés par les tables Supabase
  `authorized_groups` et `users` (plus de fichiers locaux à synchroniser).
- `fly.toml` — le projet a été migré de Fly.io vers Render ; toute la
  configuration de déploiement vit dans `render.yaml`.

## 3. Schéma Supabase (PostgreSQL)

### Table `users` (créée par le Module 1, réutilisée ici)

| Colonne         | Type    | Usage cote bot                                   |
|-----------------|---------|---------------------------------------------------|
| `id`            | int4    | non utilise directement par le bot                |
| `phone_number`  | varchar | identifiant unique du membre (JID sans `@c.us`)    |
| `username`      | varchar | pseudo affiche dans les commandes/classement       |
| `xp`            | int4    | credite automatiquement (+1/message), modifiable via `/addxp`, `/removexp` |
| `level`         | int4    | recalcule a chaque changement d'XP (`floor(xp/500)+1`) |
| `role`          | varchar | **non touche par le bot** (utilise par le Module 1 pour le "style" du membre) |

Le bot ne crée **jamais** de nouveau membre : si un numéro qui écrit dans un
groupe actif n'existe pas encore dans `users`, son message est simplement
ignoré (pas de crédit d'XP). Les membres sont ajoutés via le Dashboard
(Module 1).

### Tables ajoutées par ce module (`sql/schema_module2.sql`)

```sql
CREATE TABLE IF NOT EXISTS authorized_groups (
  id SERIAL PRIMARY KEY,
  group_jid VARCHAR NOT NULL UNIQUE,   -- ex: "1203xxxxxxxxx-1234567890@g.us"
  group_name VARCHAR,
  activated_by VARCHAR,                -- numero de l'admin qui a active le groupe
  activated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bot_admins (
  id SERIAL PRIMARY KEY,
  phone_number VARCHAR NOT NULL UNIQUE, -- format "2376xxxxxxxx" (sans @c.us, sans +)
  added_by VARCHAR,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

**Pourquoi deux tables séparées plutôt que de réutiliser `role` sur `users` ?**
La colonne `role` de `users` sert déjà, côté Module 1, à stocker le "style" du
membre (Actif/Modérateur/Débutant...). La réutiliser aussi pour distinguer les
admins du bot créerait une collision de sens dans une seule et même colonne.
Deux tables dédiées évitent l'ambiguïté et restent faciles à faire évoluer
indépendamment.

À exécuter une fois dans l'éditeur SQL Supabase avant le premier démarrage du
bot.

## 4. Modèle de permissions

Deux niveaux :

- **`SUPER_ADMIN_NUMBERS`** (variable d'environnement, liste de numéros
  séparés par des virgules) — toujours autorisés, quoi qu'il arrive. Ce sont
  les seuls à pouvoir utiliser `/add-admin` et `/remove-admin` (pour éviter
  qu'un admin ajouté puisse en cascade promouvoir d'autres admins).
- **`bot_admins`** (table Supabase) — numéros ajoutés via `/add-admin`. Ils
  peuvent utiliser toutes les commandes de modération courantes
  (`/addxp`, `/removexp`, `/activer-groupe`, `/desactiver-groupe`) mais pas
  la gestion des admins eux-mêmes.

`isBotAdmin(numero) = SUPER_ADMIN_NUMBERS.includes(numero) || bot_admins.has(numero)`

**Cas particulier : le numéro du bot est aussi un numéro admin.** Si le compte
WhatsApp auquel le bot est connecté est le même numéro que celui utilisé pour
taper les commandes (cas fréquent avec un numéro WhatsApp Business dédié), ce
numéro doit être ajouté à `SUPER_ADMIN_NUMBERS` comme n'importe quel autre — le
bot gère ce cas correctement depuis le correctif de la section 6 ci-dessous.

## 5. Commandes WhatsApp

| Commande | Qui peut l'utiliser | Effet |
|---|---|---|
| `/id` | tout le monde | affiche l'ID technique du groupe courant (utile pour du débogage) |
| `/activer-groupe` | **numéro du bot uniquement** | active le suivi XP dans le groupe courant (max **5** groupes simultanés) |
| `/desactiver-groupe` | **numéro du bot uniquement** | désactive le suivi XP dans le groupe courant |
| `/addxp @membre <montant>` | admin | ajoute de l'XP, notifie le groupe avec mention |
| `/removexp @membre <montant>` | admin | retire de l'XP (jamais sous 0), notifie le groupe avec mention |
| `/add-admin @membre` | Super Admin uniquement | donne les droits d'admin du bot à ce numéro |
| `/remove-admin @membre` | Super Admin uniquement | retire les droits d'admin du bot |
| `/xp [@membre]` | tout le monde | affiche l'XP (le sien ou celui du membre mentionné) |
| `/top` ou `/leaderboard` | tout le monde | classement des 20 meilleurs (médailles 🥇🥈🥉) |

Toute commande inconnue est ignorée silencieusement (pas de bruit dans le
groupe). Contrairement aux autres commandes de modération, `/activer-groupe`
et `/desactiver-groupe` ne vérifient pas `SUPER_ADMIN_NUMBERS`/`bot_admins` :
seul un message envoyé depuis le numéro exact du bot (`client.info.wid.user`)
est accepté.

## 6. Lecture des messages : `message_create`, pas `message`

**Point critique si le bot est connecté avec le même numéro que celui utilisé
pour envoyer les commandes** (ex. un numéro WhatsApp Business partagé) :

`whatsapp-web.js` propose deux évènements :
- `message` — se déclenche uniquement pour les messages reçus **d'autres
  comptes**. Un message envoyé depuis le numéro même auquel le bot est
  connecté (`fromMe: true`) ne déclenche **jamais** cet évènement.
- `message_create` — se déclenche pour **tous** les messages, y compris ceux
  envoyés par ce numéro.

Ce bot écoute `message_create`. Si le numéro admin est le même que celui du
bot, ses commandes sont donc bien traitées. Pour éviter tout bruit ou boucle,
seules les commandes (texte commençant par `/`) envoyées depuis ce numéro sont
traitées — un message normal (non-commande) envoyé depuis le numéro du bot
n'est jamais compté comme XP (voir `bot.js`, juste après `if (msg.fromMe...`).

Autre subtilité gérée : pour un message envoyé par le numéro du bot lui-même,
`msg.author` n'est pas renseigné par `whatsapp-web.js` (seul `msg.from`, qui
pour un message de groupe est l'ID du **groupe**, pas celui de l'expéditeur).
Le bot résout donc le numéro de l'expéditeur via `client.info.wid.user`
(disponible après l'évènement `ready`) dans ce cas précis plutôt que de se
fier à `msg.author` — voir la fonction `senderNumberFromMsg()`.

## 7. Crédit d'XP automatique — par lot toutes les 60s

- Chaque message texte envoyé dans un groupe actif incrémente un compteur
  **en mémoire** (`pendingXP`, une `Map` numéro → nombre de messages), sans
  écrire dans Supabase immédiatement.
- Toutes les 60 secondes, `flushPendingXP()` envoie **une requête `UPDATE` par
  numéro** avec le total accumulé, puis repart sur une `Map` vide — les
  messages qui arrivent pendant l'envoi du lot précédent s'accumulent déjà
  dans le lot suivant, sans rien bloquer ni perdre.
- `WHERE phone_number = $2` ne modifie que les lignes existantes : un numéro
  absent de `users` n'affecte simplement aucune ligne (pas de création
  automatique de membre).
- En cas d'échec Supabase lors de l'envoi d'un lot, le décompte concerné est
  remis en attente pour le prochain essai plutôt que d'être perdu.
- Le lot en cours est aussi vidé lors d'un arrêt propre (`SIGTERM`/`SIGINT`),
  pour ne rien perdre à chaque redéploiement Render.
- **Pourquoi par lot plutôt qu'immédiat ?** Ça réduit fortement le nombre de
  requêtes Supabase sur un groupe actif (une requête par numéro par minute au
  lieu d'une par message), au prix d'un délai de crédit allant jusqu'à 60s —
  largement acceptable pour un système d'XP.
- `GET /health` expose `numerosEnAttenteXP` (taille du lot en cours) pour
  observabilité.

## 8. Résilience Supabase (mêmes principes que le Module 1)

- `Pool` `pg` configuré avec des timeouts stricts (`connectionTimeoutMillis`,
  `idleTimeoutMillis`, `statement_timeout`, `query_timeout`) pour ne jamais
  rester bloqué indéfiniment sur une requête.
- `pool.on('error', ...)` **obligatoire** : sans ce listener, une erreur sur
  une connexion inactive du pool ferait planter tout le process Node.
- Caches en mémoire (`cachedGroups`, `cachedAdmins`) rafraîchis toutes les
  60s : si Supabase est temporairement indisponible, le bot continue de
  fonctionner avec la dernière version connue plutôt que de s'arrêter.

## 9. Connexion WhatsApp : QR code affiché sur une page web

Comme Render ne permet pas de scanner un QR code ASCII affiché dans des logs
texte de façon pratique, le bot génère le QR code sous forme d'image et
l'affiche sur une page web servie par le bot lui-même :

- Au démarrage (ou après une déconnexion), ouvrir l'URL du service Render
  dans un navigateur — la page affiche le QR code tant que la session n'est
  pas authentifiée.
- Scanner ce QR code depuis *WhatsApp → Paramètres → Appareils liés → Relier
  un appareil* sur le téléphone qui doit être connecté au bot.
- Une fois connecté, la page affiche simplement "Bot XP WhatsApp en ligne".
- `GET /health` indique aussi `qrAvailable: true/false` si besoin de vérifier
  par une autre voie.

## 10. Robustesse ajoutée (améliorations par rapport à la version initiale)

- **Reconnexion automatique** : sur l'évènement `disconnected`, le bot tente
  de se ré-initialiser après 15s (avec un verrou pour éviter les tentatives
  simultanées en boucle).
- **Arrêt propre (`SIGTERM`/`SIGINT`)** : Render envoie `SIGTERM` avant de
  tuer le process à chaque redéploiement. Sans le gérer, la session WhatsApp
  peut être laissée dans un état incohérent, forçant un nouveau QR code au
  redémarrage suivant. Le handler ferme proprement le client WhatsApp et le
  pool PostgreSQL avant de quitter.
- **`process.on('unhandledRejection'/'uncaughtException')`** : logge au lieu
  de planter silencieusement.
- **`GET /health`** : endpoint minimal utilisé par le healthcheck Render.

## 11. Variables d'environnement

| Variable | Obligatoire | Exemple | Description |
|---|---|---|---|
| `DATABASE_URL` | oui | `postgresql://...supabase.co:5432/postgres` | connexion Supabase (mode "URI", depuis Project Settings → Database) |
| `SUPER_ADMIN_NUMBERS` | recommandée | `2376xxxxxxxx,2376yyyyyyyy` | numéros toujours admins, seuls à pouvoir gérer les autres admins (inclure le numéro du bot ici s'il sert aussi à taper des commandes) |
| `PUPPETEER_EXECUTABLE_PATH` | définie par le `Dockerfile` | `/usr/bin/chromium` | chemin du Chromium système (ne pas redéfinir manuellement) |
| `PORT` | fournie par Render | — | port du serveur web (QR code + healthcheck) |

## 12. Déploiement sur Render — guide pas à pas

⚠️ **Plan Free non utilisable** : il met le service en veille après 15 min
d'inactivité HTTP, ce qui coupe la connexion WhatsApp permanente. Il faut un
plan payant (**Starter** minimum), qui permet aussi d'attacher un disque
persistant.

### Étape 1 — Préparer Supabase

Dans l'éditeur SQL Supabase, exécuter le contenu de `sql/schema_module2.sql`
(crée `authorized_groups` et `bot_admins`). La table `users` doit déjà exister
(créée par le Module 1).

### Étape 2 — Pousser le projet sur GitHub

```bash
git init
git add .
git commit -m "Module 2 - Bot WhatsApp pret pour Render"
git branch -M main
git remote add origin https://github.com/<utilisateur>/<repo>.git
git push -u origin main
```

### Étape 3 — Créer le service sur Render

**Option A — via `render.yaml` (Blueprint, recommandé)**

1. Sur [render.com](https://render.com) → **New +** → **Blueprint** → sélectionner le dépôt.
2. Render détecte `render.yaml` et propose de créer le service `xp-whatsapp-bot`
   (Docker, plan Starter, disque persistant `/app/.wwebjs_auth`, healthcheck `/health`).
3. Renseigner les variables marquées `sync: false` : `DATABASE_URL`, `SUPER_ADMIN_NUMBERS`.
4. **Apply** → le build démarre (installation de Chromium incluse, peut prendre
   quelques minutes la première fois).

**Option B — configuration manuelle**

1. **New +** → **Web Service** → connecter le dépôt GitHub.
2. **Runtime** : Docker (Render détecte le `Dockerfile` automatiquement).
3. **Plan** : Starter minimum.
4. **Health Check Path** : `/health`.
5. Onglet **Disks** → ajouter un disque : mount path `/app/.wwebjs_auth`, 1 Go.
6. Onglet **Environment** → ajouter `DATABASE_URL`, `SUPER_ADMIN_NUMBERS`.
7. **Create Web Service**.

### Étape 4 — Scanner le QR code

Une fois le déploiement terminé, ouvrir l'URL publique du service
(`https://xp-whatsapp-bot.onrender.com` ou équivalent) dans un navigateur — le
QR code y apparaît. Le scanner avec le téléphone du numéro qui doit être
connecté au bot (*WhatsApp → Paramètres → Appareils liés → Relier un
appareil*).

### Étape 5 — Vérifier la connexion

Dans l'onglet **Logs** Render, chercher la ligne `Bot XP WhatsApp connecté
(numéro : ...)`. Elle confirme que la session est active et affiche le numéro
détecté — vérifier qu'il correspond bien au numéro attendu.

### Étape 6 — Activer un groupe et ajouter des admins

Dans le groupe WhatsApp cible, un admin (listé dans `SUPER_ADMIN_NUMBERS`, ou
ajouté ensuite via `/add-admin`) tape :

```
/activer-groupe
```

Le bot répond en confirmant l'activation. Ensuite, chaque message d'un membre
déjà enregistré dans `users` (via le Dashboard, Module 1) crédite
automatiquement +1 XP.

### Après le premier scan

La session est sauvegardée sur le disque persistant : les redémarrages et
redéploiements suivants **ne redemandent pas** de QR code, sauf si le disque
est supprimé/recréé ou si WhatsApp invalide la session côté téléphone
(déconnexion manuelle de l'appareil lié, par exemple).

## 13. Développement local

```bash
npm install
export DATABASE_URL="postgresql://..."
export SUPER_ADMIN_NUMBERS="2376xxxxxxxx"
node bot.js
```

Puis ouvrir `http://localhost:8080` pour scanner le QR code affiché.

En local sous Windows, le bot utilise automatiquement le Chrome installé sur
la machine (`C:\Program Files\Google\Chrome\Application\chrome.exe`) si
`PUPPETEER_EXECUTABLE_PATH` n'est pas définie. Sous macOS/Linux en local sans
cette variable, Puppeteer utilisera son propre Chromium téléchargé (nécessite
que `PUPPETEER_SKIP_CHROMIUM_DOWNLOAD` ne soit **pas** définie localement,
contrairement au conteneur Docker).

## 14. Régénérer le ZIP livrable

```bash
npm run zip
```

Crée `module2-bot.zip` à la racine (voir `make-zip.js` pour la liste exacte
des fichiers inclus — la session `.wwebjs_auth/` et `node_modules/` en sont
volontairement exclus).

## 15. Référence des tags de logs

Chaque ligne de log importante commence par un tag entre crochets, pour filtrer facilement dans les logs Render :

| Tag | Signification |
|---|---|
| `[BOOT]` | démarrage du process, état des variables d'environnement |
| `[QR]` | génération/disponibilité du QR code |
| `[AUTH]` / `[AUTH_ERROR]` | authentification WhatsApp réussie / échouée |
| `[READY]` | client WhatsApp connecté et opérationnel, numéro détecté |
| `[DISCONNECTED]` / `[RECONNECT]` | perte de connexion / tentative de reconnexion |
| `[CACHE]` | rafraîchissement des groupes actifs / admins bot en mémoire |
| `[INCOMING]` | réception d'un message WhatsApp (avant tout filtre) — **si cette ligne n'apparaît jamais, `message_create` ne se déclenche pas du tout** |
| `[CMD]` | commande détectée et transmise à `handleCommand` |
| `[DENIED]` | commande refusée pour cause de permission |
| `[XP QUEUE]` / `[XP FLUSH]` / `[XP SAVE]` | mise en attente, envoi du lot, crédit XP effectif |
| `[DB QUERY]` / `[DB QUERY OK]` / `[DB ERROR]` | chaque requête Supabase envoyée, son résultat, ou son échec |
| `[DB SUCCESS]` | confirmation explicite d'une activation/désactivation de groupe |
| `[MSG ERROR]` | exception non prévue pendant le traitement d'un message |

**Diagnostic pas à pas si `/activer-groupe` ne fonctionne toujours pas :**
1. Chercher `[READY]` dans les logs — confirme la connexion et affiche le numéro détecté (`BOT_NUMBER`).
2. Taper `/activer-groupe` et chercher `[INCOMING]` juste après — absent = le message n'atteint jamais le bot (problème de session/connexion WhatsApp, souvent lié à un numéro Business).
3. Si `[INCOMING]` apparaît mais pas `[CMD]` : le message n'a pas été reconnu comme commande (vérifier `msg.fromMe`, le corps du message).
4. Si `[CMD]` apparaît suivi de `[DENIED]` : comparer le numéro affiché avec celui de `[READY]` — s'ils diffèrent, `SUPER_ADMIN_NUMBERS`/le numéro attendu ne correspond pas à ce que WhatsApp rapporte réellement.
5. Si `[DB SUCCESS]` apparaît mais que la table Supabase reste vide : vérifier qu'on regarde bien le même projet/la même table (`authorized_groups`) que celle configurée dans `DATABASE_URL`.

## 16. Dépannage rapide

| Symptôme | Cause probable | Solution |
|---|---|---|
| Aucune commande ne fonctionne, rien en base | Le bot écoutait `message` au lieu de `message_create` (corrigé) | Vérifier que `bot.js` utilise bien `client.on('message_create', ...)` |
| `Cannot find module 'qrcode'` au démarrage | Dépendance manquante dans `package.json` | Vérifier que `"qrcode"` est bien dans `dependencies` |
| QR code jamais affiché | Session déjà authentifiée, ou service en veille (plan Free) | Vérifier `/health` (`qrAvailable`) ; passer au plan Starter |
| Le bot redemande un QR code à chaque redéploiement | Pas de disque persistant monté, ou arrêt non propre (SIGTERM ignoré) | Vérifier le disque dans l'onglet Disks Render |
| `/addxp` répond "membre non enregistré" | Le numéro cible n'existe pas dans `users` | L'ajouter via le Dashboard (Module 1) |

## 17. Historique des décisions de conception (pour contexte)

- **Pourquoi Supabase comme unique source de vérité pour l'XP ?** Pour que le
  Dashboard (Module 1) et le bot (Module 2) partagent exactement les mêmes
  données sans synchronisation manuelle.
- **Pourquoi pas de file d'attente locale pour les coupures Supabase
  (contrairement au Module 1) ?** Le volume de messages WhatsApp peut être
  élevé et la fenêtre d'indisponibilité de Supabase est censée rester courte
  (timeouts de 5-6s) ; rejouer des crédits d'XP manqués ajouterait une
  complexité (dédup, ordre, persistance locale) jugée disproportionnée pour
  l'instant. Signalé comme amélioration possible si le besoin se confirme.
- **Pourquoi Render plutôt que Fly.io ?** Choix opérationnel de l'utilisateur
  en cours de projet — le code n'avait pas de dépendance forte à Fly.io
  (Docker standard), la migration s'est donc limitée aux fichiers de
  configuration de déploiement.
- **Pourquoi un QR code sur page web plutôt qu'un code d'appairage ?** Choix
  opérationnel de l'utilisateur — plus simple à obtenir depuis un navigateur
  que depuis les logs texte d'un service cloud.
- **Pourquoi `message_create` plutôt que `message` ?** Nécessaire dès lors que
  le numéro utilisé pour envoyer les commandes est le même que celui du bot
  (cas d'un numéro WhatsApp Business partagé) — voir section 6.
- **Pourquoi pas d'IA pour identifier l'auteur d'un message ou valider les
  commandes ?** L'identification du numéro est une donnée fiable du protocole
  WhatsApp (`msg.author`/`msg.from`/`client.info.wid.user`) — une IA n'y
  ajouterait rien. Pour la validation des permissions, une IA serait
  probabiliste et manipulable (un message conçu pour la tromper — injection
  de prompt), en plus d'ajouter coût, latence, et un point de panne
  supplémentaire (plus aucune commande ne fonctionnerait si le service IA est
  indisponible). Les vérifications de permission restent donc du code
  déterministe (`SUPER_ADMIN_NUMBERS`, `bot_admins`, comparaison directe de
  numéro). Le comptage XP "par lot" proposé à l'origine avec une IA est en
  revanche implémenté (section 7), simplement sans IA.
