-- Schéma D1 — module "Dépenses & Scan de reçus"
-- À exécuter avec : wrangler d1 execute <NOM_DB> --file=./schema.sql

CREATE TABLE IF NOT EXISTS entreprises (
    id TEXT PRIMARY KEY,          -- uuid, un tenant = une entreprise cliente
    nom TEXT NOT NULL,
    palier TEXT NOT NULL DEFAULT 'basique',  -- basique | essentiel | pro
    regime TEXT NOT NULL DEFAULT 'patente_simplifie',  -- patente_simplifie | it_complet | societe
    activite_type TEXT DEFAULT 'services',   -- services | commerce (fixe le seuil applicable)
    seuil_ca_annuel REAL DEFAULT 10000000,   -- 10M XPF (services) ou 15M XPF (commerce/hébergement)
    numero_patente TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS utilisateurs (
    id TEXT PRIMARY KEY,
    entreprise_id TEXT NOT NULL REFERENCES entreprises(id),
    email TEXT NOT NULL UNIQUE,
    nom TEXT,
    role TEXT NOT NULL DEFAULT 'membre',  -- admin | membre
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS fournisseurs (
    id TEXT PRIMARY KEY,
    entreprise_id TEXT NOT NULL REFERENCES entreprises(id),
    nom TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Le reçu brut : l'image + le résultat de l'extraction IA, avant validation humaine
CREATE TABLE IF NOT EXISTS recus_scannes (
    id TEXT PRIMARY KEY,
    entreprise_id TEXT NOT NULL REFERENCES entreprises(id),
    utilisateur_id TEXT NOT NULL REFERENCES utilisateurs(id),
    r2_key TEXT NOT NULL,              -- chemin du fichier image dans le bucket R2
    statut TEXT NOT NULL DEFAULT 'en_attente',  -- en_attente | extrait | valide | rejete
    extraction_brute TEXT,             -- JSON brut renvoyé par le modèle vision (pour debug/ré-essai)
    fournisseur_detecte TEXT,
    montant_ttc_detecte REAL,
    montant_tva_detecte REAL,
    date_detectee TEXT,
    categorie_detectee TEXT,
    confiance REAL,                    -- score de confiance du modèle (0-1) si disponible
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- La dépense validée : c'est ce qui alimente la compta et le rapport TVA
CREATE TABLE IF NOT EXISTS depenses (
    id TEXT PRIMARY KEY,
    entreprise_id TEXT NOT NULL REFERENCES entreprises(id),
    recu_id TEXT REFERENCES recus_scannes(id),  -- NULL si saisie manuelle sans scan
    fournisseur_id TEXT REFERENCES fournisseurs(id),
    libelle TEXT NOT NULL,
    montant_ht REAL NOT NULL,
    montant_tva REAL NOT NULL DEFAULT 0,
    montant_ttc REAL NOT NULL,
    taux_tva REAL NOT NULL DEFAULT 0,  -- ex. 0.13 pour 13% (à ajuster selon barème PF)
    categorie TEXT,                    -- ex. fournitures, carburant, sous-traitance...
    date_depense TEXT NOT NULL,
    created_by TEXT NOT NULL REFERENCES utilisateurs(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_depenses_entreprise_date ON depenses(entreprise_id, date_depense);
CREATE INDEX IF NOT EXISTS idx_recus_entreprise_statut ON recus_scannes(entreprise_id, statut);

-- Le pendant des dépenses : ce qui rentre. Ensemble, depenses + recettes = le
-- livre-journal recettes/dépenses exigé par la DICP pour un patenté sous le seuil.
CREATE TABLE IF NOT EXISTS recettes (
    id TEXT PRIMARY KEY,
    entreprise_id TEXT NOT NULL REFERENCES entreprises(id),
    recu_id TEXT REFERENCES recus_scannes(id),
    client_nom TEXT,
    libelle TEXT NOT NULL,
    montant REAL NOT NULL,
    mode_encaissement TEXT DEFAULT 'especes',  -- especes | cheque | virement | carte
    date_recette TEXT NOT NULL,
    created_by TEXT NOT NULL REFERENCES utilisateurs(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_recettes_entreprise_date ON recettes(entreprise_id, date_recette);
