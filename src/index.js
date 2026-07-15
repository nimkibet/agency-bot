// backend/src/index.js
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5005;

// Bulletproof CORS Configuration
const allowedOrigins = [
    'https://seek-on.app',
    'https://www.seek-on.app',
    'http://localhost:3000',
    'https://whats-app-one-green.vercel.app'
];

app.use(cors({
    origin: function (origin, callback) {
        // Allow requests with no origin (like mobile apps or curl requests)
        if (!origin) return callback(null, true);
        if (allowedOrigins.indexOf(origin) === -1) {
            var msg = 'The CORS policy for this site does not allow access from the specified Origin.';
            return callback(new Error(msg), false);
        }
        return callback(null, true);
    },
    credentials: true
}));

// Enable pre-flight across-the-board
// Removed app.options because app.use(cors()) handles it natively and Express 5 throws a PathError on wildcards.
app.use(express.json());

// In-Memory Session Manager for active Baileys sockets
// Key: tenantId, Value: { sock, status, pairingCode }
const activeSessions = new Map();

// --- MONGOOSE SCHEMAS ---
const TenantConfigSchema = new mongoose.Schema({
    tenantId: { type: String, required: true, unique: true },
    businessName: String,
    whatsappNumber: String,
    botStatus: { type: String, enum: ['connected', 'connecting', 'disconnected', 'paused'], default: 'disconnected' },
    engineMode: { type: String, enum: ['ai', 'deterministic'], default: 'ai' },
    aiPrompt: { type: String, default: 'You are a helpful business assistant.' },
    fallbackMessage: { type: String, default: 'We are currently busy. We will get back to you shortly.' }
});
// Avoid OverwriteModelError
const TenantConfig = mongoose.models.TenantConfig || mongoose.model('TenantConfig', TenantConfigSchema);

const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');

// --- ACTUAL BAILEYS INITIALIZATION TRIGGER ---
async function initializeBaileysSession(tenantId) {
    console.log(`Starting Baileys session engine for tenant: ${tenantId}`);
    
    // Use multi file auth state to persist sessions per tenant
    const { state, saveCreds } = await useMultiFileAuthState(`auth_info_${tenantId}`);
    
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }) // suppress extreme logs
    });

    // Set initial status to connecting
    activeSessions.set(tenantId, { sock, status: 'connecting', qr: null });
    await TenantConfig.findOneAndUpdate({ tenantId }, { botStatus: 'connecting' }, { upsert: true });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        let sessionData = activeSessions.get(tenantId);
        if (!sessionData) return;

        if (qr) {
            // Live QR code from WhatsApp Web API
            sessionData.qr = qr;
            activeSessions.set(tenantId, sessionData);
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log(`Connection closed for ${tenantId}. Reconnecting: ${shouldReconnect}`);
            
            if (shouldReconnect) {
                initializeBaileysSession(tenantId);
            } else {
                activeSessions.delete(tenantId);
                await TenantConfig.findOneAndUpdate({ tenantId }, { botStatus: 'disconnected' });
            }
        } else if (connection === 'open') {
            console.log(`Connection opened for ${tenantId}`);
            sessionData.status = 'connected';
            sessionData.qr = null;
            activeSessions.set(tenantId, sessionData);
            await TenantConfig.findOneAndUpdate({ tenantId }, { botStatus: 'connected' });
        }
    });

    // Listen for incoming messages and reply
    sock.ev.on('messages.upsert', async (m) => {
        // Only process new messages
        if (m.type !== 'notify') return;
        
        const msg = m.messages[0];
        // Ignore own messages and missing text
        if (!msg.message || msg.key.fromMe) return;

        // Extract text depending on message type (text or extended text)
        const incomingText = msg.message.conversation || msg.message.extendedTextMessage?.text;
        if (!incomingText) return;

        const remoteJid = msg.key.remoteJid;
        // Only respond in direct messages (ignore groups for now)
        if (!remoteJid.endsWith('@s.whatsapp.net')) return;

        console.log(`Received message from ${remoteJid}: ${incomingText}`);

        try {
            // Fetch tenant config to determine the response
            let config = await TenantConfig.findOne({ tenantId });
            if (!config) {
                config = await TenantConfig.create({ tenantId, businessName: `Tenant ${tenantId}` });
            }
            
            // --- IN-CHAT CONFIGURATION COMMANDS ---
            if (incomingText.startsWith('/setbiz ')) {
                const newBizName = incomingText.replace('/setbiz ', '').trim();
                config.businessName = newBizName;
                await config.save();
                await sock.readMessages([msg.key]);
                return await sock.sendMessage(remoteJid, { text: `✅ Business name updated to: *${newBizName}*` }, { quoted: msg });
            }

            if (incomingText.startsWith('/setprompt ')) {
                const newPrompt = incomingText.replace('/setprompt ', '').trim();
                config.aiPrompt = newPrompt;
                await config.save();
                await sock.readMessages([msg.key]);
                return await sock.sendMessage(remoteJid, { text: `✅ AI Prompt updated successfully! Bot is now instructed with your rules.` }, { quoted: msg });
            }

            if (incomingText.startsWith('/setmode ')) {
                const newMode = incomingText.replace('/setmode ', '').trim().toLowerCase();
                if (newMode === 'ai' || newMode === 'deterministic') {
                    config.engineMode = newMode;
                    await config.save();
                    await sock.readMessages([msg.key]);
                    return await sock.sendMessage(remoteJid, { text: `✅ Engine mode updated to: *${newMode}*` }, { quoted: msg });
                }
            }
            // --- END IN-CHAT CONFIGURATION ---

            let responseText = '';

            if (config?.engineMode === 'ai' && process.env.GROQ_API_KEY) {
                // Use Groq AI Engine
                const Groq = require('groq-sdk');
                const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
                
                const systemPrompt = `You are a helpful WhatsApp assistant for an organization named "${config.businessName || 'our company'}". 
                ${config.aiPrompt || 'Please assist the user kindly and professionally.'}`;

                const chatCompletion = await groq.chat.completions.create({
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: incomingText }
                    ],
                    model: 'llama3-8b-8192', // or any other groq model
                    temperature: 0.5,
                    max_tokens: 150,
                });
                
                responseText = chatCompletion.choices[0]?.message?.content || config.fallbackMessage;
            } else {
                // Fallback / Deterministic mode
                responseText = config?.fallbackMessage || 'We are currently busy. We will get back to you shortly.';
            }
            
            await sock.readMessages([msg.key]); // Mark as read
            await sock.sendMessage(remoteJid, { text: responseText }, { quoted: msg });
        } catch (err) {
            console.error('Error handling incoming message:', err);
        }
    });
}

// --- REST API ENDPOINTS ---

// 1. Get Tenant Status and Details
app.get('/api/sessions/status/:tenantId', async (req, res) => {
    try {
        const { tenantId } = req.params;
        let config = await TenantConfig.findOne({ tenantId });
        
        if (!config) {
            config = await TenantConfig.create({ tenantId, businessName: `Tenant ${tenantId}` });
        }

        const liveSession = activeSessions.get(tenantId);
        res.json({
            config,
            liveStatus: liveSession ? liveSession.status : config.botStatus,
            qr: liveSession ? liveSession.qr : null
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 2. Initiate WhatsApp Connection Link
app.post('/api/sessions/initiate', async (req, res) => {
    try {
        const { tenantId } = req.body;
        if (!tenantId) return res.status(400).json({ error: 'Tenant ID is required' });

        await initializeBaileysSession(tenantId);
        res.json({ success: true, message: 'Session initialization triggered' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 3. Save AI Prompt Engine Configurations
app.post('/api/config/update-prompt', async (req, res) => {
    try {
        const { tenantId, engineMode, aiPrompt, fallbackMessage } = req.body;
        
        const updatedConfig = await TenantConfig.findOneAndUpdate(
            { tenantId },
            { engineMode, aiPrompt, fallbackMessage },
            { new: true, upsert: true }
        );

        res.json({ success: true, config: updatedConfig });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 4. Terminate / Stop Bot Session
app.post('/api/sessions/stop', async (req, res) => {
    try {
        const { tenantId } = req.body;
        
        if (activeSessions.has(tenantId)) {
            // In real code: activeSessions.get(tenantId).sock.logout();
            activeSessions.delete(tenantId);
        }

        await TenantConfig.findOneAndUpdate({ tenantId }, { botStatus: 'disconnected' });
        res.json({ success: true, message: 'Session stopped successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Database and Server Connect
mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/agency-os')
    .then(() => {
        app.listen(PORT, () => console.log(`Agency API engine actively running on port ${PORT}`));
    })
    .catch(err => console.error('Database connection crash:', err));
