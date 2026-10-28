'use strict';

/**
 * Gestion des équipes par match.
 * Les équipes sont stockées en JSONB dans la table `teams`.
 * Format : [{ name: string, color: string, players: string[] }, ...]
 */

const MAX_TEAMS = 10;
const COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6', '#1abc9c', '#e67e22', '#34495e', '#e91e63', '#00bcd4'];

class TeamsError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function validateTeams(data) {
  if (!Array.isArray(data)) throw new TeamsError(400, 'invalid_teams', 'Les équipes doivent être un tableau.');
  if (data.length > MAX_TEAMS) throw new TeamsError(400, 'too_many_teams', `Maximum ${MAX_TEAMS} équipes.`);
  return data.map((t, i) => {
    const name = String(t.name ?? `Équipe ${i + 1}`).trim().slice(0, 30) || `Équipe ${i + 1}`;
    const color = /^#[0-9a-fA-F]{6}$/.test(t.color) ? t.color : COLORS[i % COLORS.length];
    const players = Array.isArray(t.players) ? t.players.map((p) => String(p).trim().slice(0, 60)).filter(Boolean) : [];
    return { name, color, players };
  });
}

function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function createTeamsRepo(pool) {
  async function q1(sql, params = []) {
    const { rows } = await pool.query(sql, params);
    return rows[0] || null;
  }

  return {
    TeamsError,
    COLORS,

    /**
     * Récupère les équipes d'un match.
     * Retourne null si aucune équipe n'a été sauvegardée.
     */
    async getTeams(matchId) {
      const row = await q1(`SELECT * FROM teams WHERE match_id = $1`, [Number(matchId)]);
      if (!row) return null;
      return {
        match_id: row.match_id,
        data: row.data,
        created_at: row.created_at,
        updated_at: row.updated_at,
      };
    },

    /**
     * Sauvegarde les équipes pour un match (crée ou remplace).
     */
    async saveTeams(matchId, teamsData) {
      const validated = validateTeams(teamsData);
      const { rows } = await pool.query(
        `INSERT INTO teams (match_id, data, updated_at)
         VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (match_id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()
         RETURNING *`,
        [Number(matchId), JSON.stringify(validated)]
      );
      return { match_id: rows[0].match_id, data: rows[0].data, created_at: rows[0].created_at, updated_at: rows[0].updated_at };
    },

    /**
     * Met à jour partiellement les équipes (noms, couleurs) sans changer les joueurs.
     */
    async updateTeams(matchId, teamsData) {
      return this.saveTeams(matchId, teamsData);
    },

    /**
     * Supprime les équipes d'un match.
     */
    async deleteTeams(matchId) {
      const { rowCount } = await pool.query(`DELETE FROM teams WHERE match_id = $1`, [Number(matchId)]);
      if (!rowCount) throw new TeamsError(404, 'not_found', `Aucune équipe trouvée pour ce match.`);
    },

    /**
     * Tire les équipes au sort à partir des inscrits (ou d'une liste fournie).
     * @param {number} matchId
     * @param {string[]} playerNames - Liste des prénoms des joueurs
     * @param {number} numTeams - Nombre d'équipes souhaitées
     */
    drawTeams(playerNames, numTeams) {
      const n = Math.max(2, Math.min(numTeams, MAX_TEAMS));
      const shuffled = shuffleArray(playerNames);
      const teams = Array.from({ length: n }, (_, i) => ({
        name: `Équipe ${i + 1}`,
        color: COLORS[i % COLORS.length],
        players: [],
      }));
      shuffled.forEach((p, i) => teams[i % n].players.push(p));
      return teams;
    },
  };
}

module.exports = { createTeamsRepo, TeamsError, COLORS };
