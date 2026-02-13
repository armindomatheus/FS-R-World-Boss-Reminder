require("dotenv").config();
const { Client, GatewayIntentBits } = require("discord.js");
const { Pool } = require("pg");

/* ===========================
   CONFIGURAÇÕES
=========================== */

const TOKEN = process.env.TOKEN;
const WATCH_CHANNEL_ID = process.env.WATCH_CHANNEL_ID;
const ROLE_TO_PING = process.env.ROLE_TO_PING;
const PING_BEFORE_MINUTES = parseInt(
    process.env.PING_BEFORE_MINUTES ?? "5",
    10,
);
const CHECK_INTERVAL_SECONDS = 10;

/* ===========================
   VALIDAÇÃO BÁSICA
=========================== */

if (!TOKEN || !WATCH_CHANNEL_ID || !ROLE_TO_PING || !process.env.DATABASE_URL) {
    console.error("❌ Variáveis obrigatórias faltando no .env");
    process.exit(1);
}

/* ===========================
   CONEXÃO POSTGRES (Railway)
=========================== */

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false,
    },
});

/* ===========================
   CRIAÇÃO DA TABELA
=========================== */

async function initDB() {
    await pool.query(`
    CREATE TABLE IF NOT EXISTS alerts (
      id SERIAL PRIMARY KEY,
      source_message_id TEXT UNIQUE NOT NULL,
      channel_id TEXT NOT NULL,
      run_at BIGINT NOT NULL,
      created_at BIGINT NOT NULL,
      fired_at BIGINT
    );
  `);
    console.log("📦 Banco pronto");
}

/* ===========================
   CLIENT DISCORD
=========================== */

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

/* ===========================
   READY
=========================== */

client.on("clientReady", async () => {
    console.log(`✅ Logado como ${client.user.tag}`);
    await initDB();
    startWorker();
});

/* ===========================
   FUNÇÃO PARA EXTRAIR TEXTO
=========================== */

function extractText(message) {
    const embed = message.embeds?.[0];

    return (
        (message.content ?? "") +
        " " +
        (embed?.title ?? "") +
        " " +
        (embed?.description ?? "") +
        " " +
        (embed?.footer?.text ?? "")
    ).trim();
}

/* ===========================
   CAPTURA DE ALERTA
=========================== */

client.on("messageCreate", async (message) => {
    try {
        if (message.channelId !== WATCH_CHANNEL_ID) return;

        const text = extractText(message).toLowerCase();

        if (!text.includes("world boss")) return;

        const match = text.match(/(\d+)\s*minutes?/);
        if (!match) {
            console.log("⚠️ Não encontrei minutos no texto.");
            return;
        }

        const minutes = parseInt(match[1], 10);

        const now = Date.now();
        const runAt =
            now + Math.max(0, minutes - PING_BEFORE_MINUTES) * 60 * 1000;

        await pool.query(
            `INSERT INTO alerts (source_message_id, channel_id, run_at, created_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (source_message_id) DO NOTHING`,
            [message.id, message.channelId, runAt, now],
        );

        console.log(
            `📝 Alerta salvo. Spawn em ${minutes} min | Ping em ${minutes - PING_BEFORE_MINUTES} min`,
        );
    } catch (err) {
        console.error("Erro ao processar mensagem:", err);
    }
});

/* ===========================
   WORKER DE DISPARO
=========================== */

function startWorker() {
    setInterval(async () => {
        try {
            const now = Date.now();

            const res = await pool.query(
                `SELECT id, channel_id
         FROM alerts
         WHERE fired_at IS NULL AND run_at <= $1`,
                [now],
            );

            for (const row of res.rows) {
                try {
                    const channel = await client.channels.fetch(row.channel_id);

                    await channel.send(
                        `⏰ <@&${ROLE_TO_PING}> World Boss spawnando em ${PING_BEFORE_MINUTES} minutos!`,
                    );

                    await pool.query(
                        `UPDATE alerts SET fired_at = $1 WHERE id = $2`,
                        [Date.now(), row.id],
                    );

                    console.log("🚀 Alerta disparado:", row.id);
                } catch (err) {
                    console.error("Erro ao disparar alerta:", err);
                }
            }
        } catch (err) {
            console.error("Erro no worker:", err);
        }
    }, CHECK_INTERVAL_SECONDS * 1000);

    console.log(
        `🛠 Worker ativo (verificando a cada ${CHECK_INTERVAL_SECONDS}s)`,
    );
}

/* ===========================
   TRATAMENTO DE ERROS
=========================== */

client.on("error", console.error);
process.on("unhandledRejection", console.error);

/* ===========================
   LOGIN
=========================== */

client.login(TOKEN);
