/**
 * make-zip.js
 * Regroupe tout le projet du Module 2 (Bot WhatsApp) dans un fichier ZIP.
 *
 * Utilisation :
 *   npm install
 *   node make-zip.js
 *
 * Resultat : module2-bot-claude.zip a la racine du projet.
 * Note : database.json et le dossier .wwebjs_auth (session WhatsApp) ne sont
 * volontairement PAS inclus dans le ZIP (donnees locales et session privee).
 */

const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

const ZIP_NAME = 'module2-bot-claude.zip';
const OUTPUT_PATH = path.join(__dirname, ZIP_NAME);

const ITEMS_TO_INCLUDE = ['bot.js', 'package.json', 'make-zip.js', 'Dockerfile', '.gitignore', 'render.yaml', 'README.md', 'COMPARAISON.md', 'sql'];

const output = fs.createWriteStream(OUTPUT_PATH);
const archive = archiver('zip', { zlib: { level: 9 } });

output.on('close', () => {
  console.log(`ZIP cree : ${ZIP_NAME} (${archive.pointer()} octets)`);
});

archive.on('warning', (err) => {
  if (err.code !== 'ENOENT') throw err;
  console.warn(err);
});

archive.on('error', (err) => {
  throw err;
});

archive.pipe(output);

ITEMS_TO_INCLUDE.forEach((item) => {
  const fullPath = path.join(__dirname, item);
  if (!fs.existsSync(fullPath)) {
    console.warn(`Attention : "${item}" est introuvable, ignore.`);
    return;
  }
  const stats = fs.statSync(fullPath);
  if (stats.isDirectory()) {
    archive.directory(fullPath, item);
  } else {
    archive.file(fullPath, { name: item });
  }
});

archive.finalize();
