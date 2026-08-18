-- ============================================================================
-- MODULE 2 - Schema Supabase complementaire (Bot WhatsApp)
-- La table `users` existe deja (Module 1). Ce script ajoute uniquement ce
-- dont le bot a besoin en plus : groupes autorises + admins du bot.
-- ============================================================================

-- Groupes WhatsApp sur lesquels le bot credite de l'XP automatiquement.
-- Limite de 5 groupes appliquee cote code (pas en SQL), pour pouvoir renvoyer
-- un message d'erreur clair dans le groupe plutot qu'une simple erreur DB.
CREATE TABLE IF NOT EXISTS authorized_groups (
  id SERIAL PRIMARY KEY,
  group_jid VARCHAR NOT NULL UNIQUE,   -- ex: "1203xxxxxxxxx-1234567890@g.us"
  group_name VARCHAR,
  activated_by VARCHAR,                -- numero (sans @c.us) de l'admin qui a active
  activated_at TIMESTAMPTZ DEFAULT now()
);

-- Numeros autorises a utiliser les commandes du bot (en plus des
-- SUPER_ADMIN_NUMBERS definis en variable d'environnement, qui restent
-- toujours autorises et sont les seuls a pouvoir gerer cette table).
CREATE TABLE IF NOT EXISTS bot_admins (
  id SERIAL PRIMARY KEY,
  phone_number VARCHAR NOT NULL UNIQUE, -- format "2376xxxxxxxx" (sans @c.us, sans +)
  added_by VARCHAR,
  created_at TIMESTAMPTZ DEFAULT now()
);
