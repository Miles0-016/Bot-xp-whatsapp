# Comparaison des deux versions livrées

Contexte : silence total dans les logs Render dès qu'un message WhatsApp
arrive dans un groupe — pas même le log `[INCOMING]` déjà présent avant cet
appel. Gemini a proposé un diagnostic et un correctif ; Claude n'est pas
entièrement d'accord avec le diagnostic, mais applique quand même le prompt
tel quel dans une version séparée pour comparaison réelle en conditions de
production.

## Le désaccord de diagnostic, en une phrase

Le `[INCOMING]` de la version précédente était déjà placé **avant** l'appel à
`msg.getChat()`, de façon synchrone. Si `getChat()` gelait comme le suppose
Gemini, ce log apparaîtrait quand même. S'il n'apparaît jamais, l'évènement
`message_create` ne se déclenche probablement pas du tout côté
`whatsapp-web.js` — ce n'est pas prouvé à 100% sans les logs Render réels,
mais c'est l'hypothèse la plus cohérente avec ce qui a été observé jusqu'ici.

## `xp-whatsapp-bot-gemini/` — prompt appliqué littéralement

- Vérification de groupe 100% synchrone (`msg.from.endsWith('@g.us')`),
  aucun `getChat()` avant le traitement des messages passifs.
- Log `[RAW MSG DETECTED]` en tout premier, avant toute condition.
- Écoute **`message` ET `message_create`** simultanément.
- Args Puppeteer exactement comme demandé, **y compris `--single-process`**.
- **Ajout non demandé par Gemini, fait par précaution** : un filet anti-doublon
  (`processedMessageIds`) empêche qu'un message reçu d'un tiers — qui
  déclenche naturellement les DEUX évènements — soit traité deux fois (XP
  compté en double, commande exécutée deux fois). Sans ce filet, écouter les
  deux évènements aurait introduit un nouveau bug.
- ⚠️ **Risque connu et documenté dans le code** : `--single-process` peut
  provoquer exactement le type de gel silencieux signalé, sous Docker avec
  peu de RAM. À surveiller en priorité si cette version ne résout rien.

## `xp-whatsapp-bot-claude/` — solution alternative

- Même vérification synchrone du groupe pour le flux normal de messages
  (bonne pratique dans tous les cas, retenue dans les deux versions).
- `getChat()` n'est appelé que pour les commandes (rares comparées au volume
  de messages passifs) — pas supprimé, juste déplacé là où il est réellement
  nécessaire (nom du groupe, envoi de réponses avec mentions).
- **Un seul listener** (`message_create`) — en écouter deux aurait dupliqué
  le traitement de chaque message reçu d'un tiers (les deux évènements se
  déclenchent pour ces messages-là).
- Args Puppeteer identiques à la demande, **sauf `--single-process`**, exclu
  volontairement pour la raison ci-dessus.
- **Ajout : `[HEARTBEAT]`** toutes les 5 minutes — permet de distinguer "le
  process Node est mort/bloqué" de "le process tourne mais whatsapp-web.js ne
  reçoit plus rien". Si les heartbeats continuent mais plus aucun
  `[RAW MSG DETECTED]` n'apparaît après un moment, le problème est confirmé
  côté session/librairie WhatsApp.
- **Pistes supplémentaires non appliquées automatiquement** (à vérifier
  manuellement, car nécessitent de connaître l'état exact de l'environnement) :
  - Version de `whatsapp-web.js` : les bots basés sur cette librairie cessent
    parfois de recevoir des évènements après une mise à jour du protocole
    WhatsApp Web côté serveur, tant que la librairie (ou son
    `webVersionCache`) n'est pas mise à jour. Vérifier la version installée
    sur Render vs la dernière disponible.
  - Plan Render : Chromium headless est gourmand en RAM. Le plan **Starter**
    (512 Mo) peut être insuffisant en pratique ; envisager **Standard** (2 Go)
    si le symptôme persiste après ces correctifs.

## Comment trancher entre les deux

Déployer l'une des deux versions, taper un message dans un groupe actif, et
chercher `[RAW MSG DETECTED]` dans les logs Render :

- **Présent** → l'évènement se déclenche bien, le problème était ailleurs
  (permissions, cache, etc.) — continuer avec les logs `[CMD]`/`[DENIED]`/
  `[DB ...]` déjà en place pour la suite du diagnostic.
- **Toujours absent, dans les DEUX versions** → confirme que le problème ne
  vient ni de `getChat()` ni du choix d'évènement, mais bien plus en amont
  (session WhatsApp, version de librairie, ressources Render). Revenir vers
  les pistes "non appliquées automatiquement" ci-dessus.
