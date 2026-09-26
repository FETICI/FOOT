# ⚽ Foot du vendredi

Application web pour organiser le foot hebdomadaire : les joueurs s'inscrivent en quelques secondes depuis le lien WhatsApp, l'organisateur gère tout depuis un espace admin protégé.

- **Liens d'inscription** : `/i/<jeton>` — trois liens secrets par match (Prioritaires, Ouvert, Invitations), à copier depuis l'admin.
- **Lien général** : `/` — infos du prochain match et liste des inscrits, **sans** possibilité de s'inscrire.
- **Administration** : `/admin` — mot de passe provisoire **`foot2026`** (à changer dans *Réglages*, 10 caractères minimum).

## Lancer en local

Prérequis : **Node.js 22.13 ou plus récent**. Aucune dépendance, pas de `npm install`.

```bash
npm start      # http://localhost:3000  et  http://localhost:3000/admin
npm test       # 16 scénarios de tests automatiques
```

La base SQLite est créée dans `./data/foot.sqlite`. Une base existante (version précédente) est **migrée automatiquement** au démarrage, sans perte de données.

## Données de démonstration

Match du vendredi 2 octobre 2026 en phase **Prioritaires** + 3 matchs d'historique, avec des profils types :

| Joueur | Statut | Participations | Tarif |
|---|---|---|---|
| Thomas, Bastien | Abonné annuel | 12 / 4 | 5 € |
| Hugo | Abonné fidélité | 7 | 5 € |
| Antoine | Non abonné | 5 → sa prochaine inscription passe à 5 € + Abonné fidélité | 5 € |
| Maxime, Lucas… | Non abonné | 4/5, 3/5… | 10 € |

Les codes joueurs sont visibles dans *Admin → Joueurs → fiche*. Tout se supprime en un clic dans *Réglages*.

## Semaine type

1. **Lundi** — *Créer le prochain foot* (tout est pré-rempli), phase **Prioritaires** → *Partager le foot → Copier lien Prioritaires* → groupe WhatsApp des abonnés.
2. **Mardi** — phase **Ouvert** → *Copier lien Ouvert* → 2ᵉ groupe. Le lien Prioritaires continue de fonctionner.
3. **Mercredi** — phase **Invitations** → *Copier lien Invitations* → envois individuels.
4. **Après le match** — marquer chaque joueur **Présent / Absent** (et encaisser les paiements). Seules les présences comptent pour la fidélité.

## Règles appliquées (toutes vérifiées côté serveur)

**Tarifs**
- Abonné annuel (30 € réglés hors site, activé à la main dans la fiche) → 5 €, prioritaire.
- Non abonné → 10 € tant qu'il a moins de 5 participations validées.
- 5 participations validées → la 6ᵉ inscription est à 5 € et le joueur devient automatiquement **Abonné fidélité** (5 € et prioritaire ensuite, pour toute la saison).
- Le tarif est enregistré sur chaque inscription : l'historique financier ne change jamais après coup.
- Les prix (normal / abonné) se règlent par match ; le lien bancaire externe reste inchangé et le statut de paiement se gère à la main.

**Phases et liens**
| Phase | Liens acceptés | Qui peut s'inscrire |
|---|---|---|
| Prioritaires | Prioritaires | Abonnés (annuel, fidélité, ou fidélité acquise) uniquement — avoir le lien ne suffit pas |
| Ouvert | Prioritaires, Ouvert | Tout le monde |
| Invitations | les trois | Tout le monde |
| Fermé / Brouillon | aucun | Personne |

Jetons de 256 bits aléatoires (43 caractères), stockés en base, régénérables depuis l'admin si un lien circule par erreur. Un lien inconnu, modifié ou d'un autre match affiche « Ce lien d'inscription n'est pas valide. » ; un lien valide utilisé trop tôt affiche « Les inscriptions ne sont pas encore ouvertes pour ce lien. »

**« Es-tu abonné ? »** n'est qu'une déclaration : le statut réel vient de la fiche. Un « oui » non confirmé affiche « Ton statut abonné n'a pas été reconnu… » avec un bouton pour s'inscrire au tarif normal.

**Identification sans compte (homonymes)**
- Première inscription : prénom seulement → une fiche est créée et le joueur reçoit un **code joueur à 4 chiffres**. Son téléphone est ensuite **reconnu automatiquement** (cookie sécurisé) : il n'a plus qu'à choisir carte/espèces.
- Nouveau téléphone, ou abonné qui s'inscrit pour la première fois : prénom + code joueur (l'organisateur le voit dans la fiche).
- Prénom déjà pris sans code : « ajoute l'initiale de ton nom (ex. Thomas B.) » → deux fiches, deux historiques, deux compteurs.
- L'admin peut **fusionner** deux fiches (historique, présences, meilleur statut regroupés), renommer, régénérer un code, oublier les téléphones.
- Un même joueur ne peut pas s'inscrire deux fois au même match ; « Inscrire un autre joueur » permet d'inscrire un ami depuis son téléphone.

**Participations** = présences de la saison + correction manuelle éventuelle. Le compteur est **recalculé** à chaque lecture (jamais incrémenté), donc aucune présence ne peut compter deux fois et une correction Présent → Absent est immédiatement prise en compte.

**Saisons** — *Réglages → Commencer une nouvelle saison* : compteurs et statuts remis à zéro (option : reconduire les abonnés annuels), anciens matchs, présences et statuts conservés et consultables.

## Mettre en ligne

Il faut un hébergeur avec **disque persistant**.

**Railway (~5 $/mois)** : dépôt GitHub → *Deploy from GitHub repo* → *Volumes* monté sur `/data` → variables `DATA_DIR=/data` et `ADMIN_PASSWORD=…` → *Generate domain*.
**Fly.io** : `fly launch` (Dockerfile fourni) + volume sur `/data`. **VPS** : `DATA_DIR=/chemin PORT=80 npm start` derrière Caddy (HTTPS).

| Variable | Rôle | Défaut |
|---|---|---|
| `PORT` | Port HTTP | `3000` |
| `DATA_DIR` | Dossier de la base SQLite (volume persistant) | `./data` |
| `ADMIN_PASSWORD` | Mot de passe admin au premier démarrage | `foot2026` |
| `RESET_ADMIN_PASSWORD` | `1` = réinitialise le mot de passe à `ADMIN_PASSWORD` | – |
| `SEED_DEMO` | `0` = pas de données de démo | `1` |

Sauvegarde : copier `foot.sqlite`.

## Sécurité

- Mot de passe admin haché (scrypt), jamais stocké en clair, 10 caractères minimum ; session signée en cookie HttpOnly, SameSite=Strict, Secure en HTTPS ; limitation des tentatives de connexion.
- Cookie « téléphone reconnu » aléatoire (HttpOnly, SameSite=Lax), seule son empreinte SHA-256 est en base ; essais de code joueur limités.
- API publiques : prénoms des inscrits et infos du match uniquement (ni paiement, ni statut, ni tarif des autres, ni jetons des autres liens, ni codes).
- Requêtes SQL paramétrées ; le front-end construit le DOM avec `textContent` (aucune donnée utilisateur dans `innerHTML`) ; CSP stricte, `X-Frame-Options: DENY`.

## Architecture

```
server.js        routes HTTP (API publique /api/public, API admin /api/admin), fichiers statiques
src/pricing.js   règles commerciales pures : tarifs, fidélité, priorité, phases/liens
src/repo.js      règles métier + accès données (inscription, joueurs, fusion, saisons…)
src/db.js        SQLite (node:sqlite), migrations versionnées (v1 → v2 automatique), démo
src/auth.js      mot de passe admin + session signée
public/          page joueur (player.js) et administration (admin.js), JS natif
test/            tests d'intégration de l'API (npm test)
```

Tables : `matches`, `registrations` (tarif, statut abonné au moment de l'inscription, présence), `players`, `player_seasons` (abonnement et correction par saison), `player_devices`, `match_links`, `seasons`, `settings`.
Pistes suivantes : équipes / tirage (table `teams` reliée aux `registrations`), notifications (hook dans `registerPublic`), statistiques de présence (déjà calculables depuis `registrations.attendance`).
