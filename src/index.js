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
    fallbackMessage: { type: String, default: 'We are currently busy. We will get back to you shortly.' },
    catalogData: { type: String, default: '' }
});
// Avoid OverwriteModelError
const TenantConfig = mongoose.models.TenantConfig || mongoose.model('TenantConfig', TenantConfigSchema);

const AuthStateSchema = new mongoose.Schema({
    tenantId: { type: String, required: true, index: true },
    key: { type: String, required: true },
    value: { type: String }
});
AuthStateSchema.index({ tenantId: 1, key: 1 }, { unique: true });
const AuthState = mongoose.models.AuthState || mongoose.model('AuthState', AuthStateSchema);

const { makeWASocket, useMultiFileAuthState, DisconnectReason, initAuthCreds, BufferJSON, proto } = require('@whiskeysockets/baileys');
const pino = require('pino');
const Groq = require('groq-sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');

async function getDualEngineResponse(incomingText, tenantConfig) {
    const fullPrompt = tenantConfig.catalogData 
        ? `${tenantConfig.aiPrompt}\n\nBusiness Catalog & Prices:\n${tenantConfig.catalogData}`
        : tenantConfig.aiPrompt;

    try {
        const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
        const chatCompletion = await groq.chat.completions.create({
            messages: [
                { role: 'system', content: fullPrompt },
                { role: 'user', content: incomingText }
            ],
            model: 'openai/gpt-oss-20b',
        });
        return chatCompletion.choices[0]?.message?.content;
    } catch (err) {
        try {
            const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
            const model = genAI.getGenerativeModel({ 
                model: 'gemini-3.1-flash-lite',
                systemInstruction: fullPrompt 
            });
            const result = await model.generateContent(incomingText);
            const response = await result.response;
            return response.text();
        } catch (fallbackErr) {
            return tenantConfig.fallbackMessage;
        }
    }
}

async function useMongoDBAuthState(tenantId) {
    const readData = async (key) => {
        const doc = await AuthState.findOne({ tenantId, key });
        if (doc && doc.value) return JSON.parse(doc.value, BufferJSON.reviver);
        return null;
    };
    const writeData = async (key, data) => {
        const value = JSON.stringify(data, BufferJSON.replacer);
        await AuthState.updateOne({ tenantId, key }, { value }, { upsert: true });
    };
    const removeData = async (key) => await AuthState.deleteOne({ tenantId, key });

    const creds = await readData('creds') || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(
                        ids.map(async id => {
                            let value = await readData(`${type}-${id}`);
                            if (type === 'app-state-sync-key' && value) {
                                value = proto.Message.AppStateSyncKeyData.fromObject(value);
                            }
                            data[id] = value;
                        })
                    );
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            if (value) tasks.push(writeData(key, value));
                            else tasks.push(removeData(key));
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: () => writeData('creds', creds)
    };
}

// --- ACTUAL BAILEYS INITIALIZATION TRIGGER ---
async function initializeBaileysSession(tenantId) {
    console.log(`Starting Baileys session engine for tenant: ${tenantId}`);
    
    // Use MongoDB auth state to persist sessions per tenant in the database
    const { state, saveCreds } = await useMongoDBAuthState(tenantId);
    
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }), // suppress extreme logs
        syncFullHistory: false, // Skip full history sync to keep it lightweight
        generateHighQualityLinkPreviews: false // Skip high-res media previews
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
                await AuthState.deleteMany({ tenantId });
                await TenantConfig.findOneAndUpdate({ tenantId }, { botStatus: 'disconnected' });
            }
        } else if (connection === 'open') {
            console.log(`Connection opened for ${tenantId}`);
            sessionData.status = 'connected';
            sessionData.qr = null;
            activeSessions.set(tenantId, sessionData);
            await TenantConfig.findOneAndUpdate({ tenantId }, { botStatus: 'connected' });
            
            try {
                const userJid = sock.user?.id?.replace(/:\d+/, '');
                if (userJid) {
                    const welcomeMsg = `🎉 *Bot Connected Successfully!*\n\n` +
                                       `Your bot is now live. You can configure it right here using the following commands:\n\n` +
                                       `*1.* \`/setbiz <business name>\` - Set your business name.\n` +
                                       `*2.* \`/setprompt <your instructions>\` - Set the AI's behavior.\n` +
                                       `*3.* \`/setfallback <your message>\` - Set the fallback message for deterministic mode or AI failures.\n` +
                                       `*4.* \`/setcatalog <items/prices>\` - Provide your catalog to the AI.\n` +
                                       `*5.* \`/status\` - Check current bot configurations.\n\n` +
                                       `Type any of these commands to get started!`;
                    await sock.sendMessage(userJid, { text: welcomeMsg });
                }
            } catch (err) {
                console.error(`Failed to send welcome message to owner of tenant ${tenantId}:`, err);
            }
        }
    });

    // Listen for incoming messages and reply
    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify') return;
        const msg = m.messages[0];
        if (!msg.message) return;

        // Extract text depending on message type (text or extended text)
        const incomingText = msg.message.conversation || msg.message.extendedTextMessage?.text;
        if (!incomingText) return;

        const remoteJid = msg.key.remoteJid;
        console.log(`Received message from ${remoteJid}: ${incomingText}`);

        try {
            // Fetch tenant config to determine the response
            let config = await TenantConfig.findOne({ tenantId });
            if (!config) {
                config = await TenantConfig.create({ tenantId, businessName: `Tenant ${tenantId}` });
            }
            
            // --- IN-CHAT CONFIGURATION COMMANDS ---
            if (incomingText.startsWith('/')) {
                // Only authorize commands if they originate from the connected WhatsApp account itself
                if (!msg.key.fromMe) {
                    await sock.sendMessage(remoteJid, { text: '❌ Error: You are not authorized to use bot configuration commands.' }, { quoted: msg });
                    return;
                }

                const [command, ...payloadArr] = incomingText.split(' ');
                const payload = payloadArr.join(' ').trim();

                switch (command.toLowerCase()) {
                    case '/setbiz':
                        if (!payload) {
                            await sock.sendMessage(remoteJid, { text: '❌ Error: Please provide a business name.' }, { quoted: msg });
                            break;
                        }
                        config.businessName = payload;
                        await config.save();
                        await sock.sendMessage(remoteJid, { text: `✅ Business name updated to: *${payload}*` }, { quoted: msg });
                        break;

                    case '/setprompt':
                        if (!payload) {
                            await sock.sendMessage(remoteJid, { text: '❌ Error: Please provide a prompt payload.' }, { quoted: msg });
                            break;
                        }
                        config.aiPrompt = payload;
                        await config.save();
                        await sock.sendMessage(remoteJid, { text: `✅ AI Prompt updated successfully! Bot is now instructed with your rules.` }, { quoted: msg });
                        break;

                    case '/setfallback':
                        if (!payload) {
                            await sock.sendMessage(remoteJid, { text: '❌ Error: Please provide a fallback payload.' }, { quoted: msg });
                            break;
                        }
                        config.fallbackMessage = payload;
                        await config.save();
                        await sock.sendMessage(remoteJid, { text: `✅ Fallback message updated to: *${payload}*` }, { quoted: msg });
                        break;

                    case '/setcatalog':
                        if (!payload) {
                            await sock.sendMessage(remoteJid, { text: '❌ Error: Please provide your catalog details.' }, { quoted: msg });
                            break;
                        }
                        config.catalogData = payload;
                        await config.save();
                        await sock.sendMessage(remoteJid, { text: `✅ Catalog updated successfully! The AI now knows your products and prices.` }, { quoted: msg });
                        break;

                    case '/status':
                        const statusMsg = `📊 *Bot Status*\n\n` +
                                          `*Tenant ID*: ${config.tenantId}\n` +
                                          `*Active Engine*: ${config.engineMode === 'ai' ? 'Dual-Engine AI' : 'Deterministic'}\n` +
                                          `*Current AI Prompt*: ${config.aiPrompt}`;
                        await sock.sendMessage(remoteJid, { text: statusMsg }, { quoted: msg });
                        break;
                    
                    default:
                        await sock.sendMessage(remoteJid, { text: `❌ Unknown command: ${command}` }, { quoted: msg });
                        break;
                }
                
                await sock.readMessages([msg.key]);
                return; // Execution Bypass
            }
            // --- END IN-CHAT CONFIGURATION ---

            // Ignore normal messages sent by the bot owner to prevent self-looping
            if (msg.key.fromMe) return;

            // Only respond in direct messages (ignore normal group messages)
            if (!remoteJid.endsWith('@s.whatsapp.net') && !remoteJid.endsWith('@lid')) return;

            let responseText = '';

            if (config?.engineMode === 'ai') {
                await sock.sendPresenceUpdate('composing', remoteJid);
                responseText = await getDualEngineResponse(incomingText, config);
            } else {
                // Fallback / Deterministic mode
                responseText = config?.fallbackMessage || 'We are currently busy. We will get back to you shortly.';
            }
            
            await sock.readMessages([msg.key]); // Mark as read
            if (responseText && responseText.trim() !== '') {
                await sock.sendMessage(remoteJid, { text: responseText }, { quoted: msg });
            }
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

        if (activeSessions.has(tenantId)) {
            const session = activeSessions.get(tenantId);
            if (session.status === 'connecting' || session.status === 'connected') {
                return res.json({ success: true, message: 'Session is already active or connecting' });
            }
        }

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
            try { activeSessions.get(tenantId).sock.logout(); } catch (e) {}
            activeSessions.delete(tenantId);
        }

        await AuthState.deleteMany({ tenantId });

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
