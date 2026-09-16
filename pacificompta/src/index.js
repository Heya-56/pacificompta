// Worker — Module Scan de reçus (IA intégrée)
// Endpoints :
//   POST /api/recus/scan      -> upload image + extraction IA -> renvoie un brouillon éditable
//   POST /api/recus/:id/valider -> confirme le brouillon (éventuellement corrigé) -> crée la dépense
//   GET  /api/recus/:id       -> relit un reçu scanné (statut, données extraites)

function uuid() {
  return crypto.randomUUID();
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Le prompt qui cadre l'extraction. On force une sortie JSON stricte pour éviter
// d'avoir à parser du texte libre.
const EXTRACTION_PROMPT = `Tu analyses une photo de document comptable (reçu d'achat, facture fournisseur, ou preuve d'encaissement client type ticket de vente/virement reçu).
Réponds UNIQUEMENT avec un objet JSON valide, sans aucun texte autour, au format exact :
{
  "type_document": "depense" ou "recette" (une dépense = de l'argent qui sort chez un fournisseur ; une recette = de l'argent qui rentre d'un client),
  "tiers": string ou null (nom du fournisseur si dépense, nom du client si recette),
  "date": string au format YYYY-MM-DD ou null,
  "montant_ttc": number ou null,
  "montant_tva": number ou null,
  "taux_tva": number ou null (ex: 0.13 pour 13%),
  "categorie": string ou null (pour une dépense, choisis parmi: fournitures, carburant, restauration, transport, sous-traitance, materiel, autre),
  "mode_encaissement": string ou null (pour une recette : especes, cheque, virement, carte),
  "confiance": number entre 0 et 1 (ta confiance globale dans cette extraction)
}
Si une information est illisible ou absente, mets null pour ce champ plutôt que d'inventer une valeur.`;

async function handleScan(request, env) {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.includes("multipart/form-data")) {
    return jsonResponse({ error: "Envoyer l'image en multipart/form-data (champ 'fichier')." }, 400);
  }

  const form = await request.formData();
  const file = form.get("fichier");
  const entrepriseId = form.get("entreprise_id");
  const utilisateurId = form.get("utilisateur_id");

  if (!file || !entrepriseId || !utilisateurId) {
    return jsonResponse({ error: "Champs requis : fichier, entreprise_id, utilisateur_id." }, 400);
  }

  const recuId = uuid();
  const r2Key = `${entrepriseId}/${recuId}-${file.name}`;

  // 1. Stockage de l'image originale sur R2 (on garde toujours la preuve)
  await env.RECUS_BUCKET.put(r2Key, file.stream(), {
    httpMetadata: { contentType: file.type },
  });

  // 2. Extraction via Workers AI (modèle vision)
  const imageBuffer = await file.arrayBuffer();
  const imageArray = [...new Uint8Array(imageBuffer)];

  let extraction;
  let extractionBrute = null;
  try {
    const aiResponse = await env.AI.run("@cf/meta/llama-3.2-11b-vision-instruct", {
      messages: [
        {
          role: "user",
          content: EXTRACTION_PROMPT,
        },
      ],
      image: imageArray,
    });

    extractionBrute = aiResponse.response || JSON.stringify(aiResponse);
    // Le modèle peut entourer le JSON de texte malgré la consigne — on isole le bloc JSON.
    const jsonMatch = extractionBrute.match(/\{[\s\S]*\}/);
    extraction = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
  } catch (err) {
    extraction = {};
    extractionBrute = `Erreur d'extraction : ${err.message}`;
  }

  const typeDocument = extraction.type_document === "recette" ? "recette" : "depense";

  // 3. On enregistre le brouillon en base — statut "extrait", pas encore validé par l'utilisateur
  await env.DB.prepare(
    `INSERT INTO recus_scannes
      (id, entreprise_id, utilisateur_id, r2_key, statut, extraction_brute,
       fournisseur_detecte, montant_ttc_detecte, montant_tva_detecte, date_detectee,
       categorie_detectee, confiance)
     VALUES (?, ?, ?, ?, 'extrait', ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      recuId,
      entrepriseId,
      utilisateurId,
      r2Key,
      extractionBrute,
      extraction.tiers ?? null,
      extraction.montant_ttc ?? null,
      extraction.montant_tva ?? null,
      extraction.date ?? null,
      extraction.categorie ?? null,
      extraction.confiance ?? null
    )
    .run();

  // 4. On renvoie un brouillon éditable au front — l'utilisateur corrige avant validation.
  // Le type_document (recette/dépense) décide vers quelle table la validation écrira.
  return jsonResponse({
    recu_id: recuId,
    statut: "extrait",
    type_document: typeDocument,
    brouillon: {
      tiers: extraction.tiers ?? "",
      date: extraction.date ?? "",
      montant_ttc: extraction.montant_ttc ?? "",
      montant_tva: extraction.montant_tva ?? "",
      taux_tva: extraction.taux_tva ?? "",
      categorie: extraction.categorie ?? "autre",
      mode_encaissement: extraction.mode_encaissement ?? "especes",
      confiance: extraction.confiance ?? null,
    },
  });
}

async function handleValidation(request, env, recuId) {
  const body = await request.json();
  const {
    entreprise_id, utilisateur_id, type_document,
    tiers, libelle, montant_ht, montant_tva, montant_ttc, taux_tva, categorie,
    mode_encaissement, date_mouvement,
  } = body;

  if (!entreprise_id || !utilisateur_id || !montant_ttc || !date_mouvement) {
    return jsonResponse({ error: "Champs requis manquants pour valider l'écriture." }, 400);
  }

  await env.DB.prepare(`UPDATE recus_scannes SET statut = 'valide' WHERE id = ?`).bind(recuId).run();

  // --- Recette : alimente le livre-journal côté encaissements ---
  if (type_document === "recette") {
    const recetteId = uuid();
    await env.DB.prepare(
      `INSERT INTO recettes
        (id, entreprise_id, recu_id, client_nom, libelle, montant, mode_encaissement, date_recette, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        recetteId, entreprise_id, recuId, tiers || null,
        libelle || tiers || "Recette", montant_ttc,
        mode_encaissement || "especes", date_mouvement, utilisateur_id
      )
      .run();
    return jsonResponse({ recette_id: recetteId, statut: "valide" });
  }

  // --- Dépense : comportement inchangé ---
  let fournisseurId = null;
  if (tiers) {
    const existing = await env.DB.prepare(
      `SELECT id FROM fournisseurs WHERE entreprise_id = ? AND nom = ?`
    )
      .bind(entreprise_id, tiers)
      .first();
    if (existing) {
      fournisseurId = existing.id;
    } else {
      fournisseurId = uuid();
      await env.DB.prepare(`INSERT INTO fournisseurs (id, entreprise_id, nom) VALUES (?, ?, ?)`)
        .bind(fournisseurId, entreprise_id, tiers)
        .run();
    }
  }

  const depenseId = uuid();
  await env.DB.prepare(
    `INSERT INTO depenses
      (id, entreprise_id, recu_id, fournisseur_id, libelle, montant_ht, montant_tva,
       montant_ttc, taux_tva, categorie, date_depense, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      depenseId, entreprise_id, recuId, fournisseurId,
      libelle || tiers || "Dépense",
      montant_ht ?? montant_ttc - (montant_tva || 0),
      montant_tva || 0, montant_ttc, taux_tva || 0,
      categorie || "autre", date_mouvement, utilisateur_id
    )
    .run();

  return jsonResponse({ depense_id: depenseId, statut: "valide" });
}

// Suivi du seuil de CA (10M ou 15M XPF selon l'activité) — pour alerter avant
// que le patenté ne sorte du régime simplifié.
async function handleSeuil(env, entrepriseId) {
  const entreprise = await env.DB.prepare(
    `SELECT seuil_ca_annuel, activite_type, regime FROM entreprises WHERE id = ?`
  )
    .bind(entrepriseId)
    .first();
  if (!entreprise) return jsonResponse({ error: "Entreprise introuvable." }, 404);

  const anneeCourante = new Date().getFullYear();
  const { total_ca } = await env.DB.prepare(
    `SELECT COALESCE(SUM(montant), 0) as total_ca FROM recettes
     WHERE entreprise_id = ? AND date_recette LIKE ?`
  )
    .bind(entrepriseId, `${anneeCourante}%`)
    .first();

  const ratio = entreprise.seuil_ca_annuel > 0 ? total_ca / entreprise.seuil_ca_annuel : 0;

  return jsonResponse({
    annee: anneeCourante,
    ca_realise: total_ca,
    seuil: entreprise.seuil_ca_annuel,
    ratio: Math.round(ratio * 100) / 100,
    alerte: ratio >= 0.8, // on prévient à partir de 80% du seuil
    regime_actuel: entreprise.regime,
  });
}

async function handleGetRecu(env, recuId) {
  const recu = await env.DB.prepare(`SELECT * FROM recus_scannes WHERE id = ?`).bind(recuId).first();
  if (!recu) return jsonResponse({ error: "Reçu introuvable." }, 404);
  return jsonResponse(recu);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/api/recus/scan" && request.method === "POST") {
      return handleScan(request, env);
    }

    const validationMatch = path.match(/^\/api\/recus\/([^/]+)\/valider$/);
    if (validationMatch && request.method === "POST") {
      return handleValidation(request, env, validationMatch[1]);
    }

    const getMatch = path.match(/^\/api\/recus\/([^/]+)$/);
    if (getMatch && request.method === "GET") {
      return handleGetRecu(env, getMatch[1]);
    }

    const seuilMatch = path.match(/^\/api\/entreprises\/([^/]+)\/seuil$/);
    if (seuilMatch && request.method === "GET") {
      return handleSeuil(env, seuilMatch[1]);
    }

    return jsonResponse({ error: "Route inconnue." }, 404);
  },
};
