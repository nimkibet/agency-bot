// backend/src/index.js
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const https = require('https');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5005;

// Bulletproof CORS Configuration
const allowedOrigins = [
    'https://seek-on.app',
    'https://www.seek-on.app',
    'http://localhost:3000',
    'http://localhost:3001',
    'https://whats-app-one-green.vercel.app'
];

app.use(cors({
    origin: function (origin, callback) {
        if (!origin) return callback(null, true);
        if (allowedOrigins.indexOf(origin) === -1) {
            var msg = 'The CORS policy for this site does not allow access from the specified Origin.';
            return callback(new Error(msg), false);
        }
        return callback(null, true);
    },
    credentials: true
}));

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
const TenantConfig = mongoose.models.TenantConfig || mongoose.model('TenantConfig', TenantConfigSchema);

const AuthStateSchema = new mongoose.Schema({
    tenantId: { type: String, required: true, index: true },
    key: { type: String, required: true },
    value: { type: String }
});
AuthStateSchema.index({ tenantId: 1, key: 1 }, { unique: true });
const AuthState = mongoose.models.AuthState || mongoose.model('AuthState', AuthStateSchema);

const PausedChatSchema = new mongoose.Schema({
    tenantId: { type: String, required: true },
    chatJid: { type: String, required: true }
});
PausedChatSchema.index({ tenantId: 1, chatJid: 1 }, { unique: true });
const PausedChat = mongoose.models.PausedChat || mongoose.model('PausedChat', PausedChatSchema);

const ChatSessionSchema = new mongoose.Schema({
    tenantId: { type: String, required: true },
    chatJid: { type: String, required: true },
    category: { type: String, enum: ['undetermined', 'business', 'personal'], default: 'undetermined' },
    greeted: { type: Boolean, default: false }
});
ChatSessionSchema.index({ tenantId: 1, chatJid: 1 }, { unique: true });
const ChatSession = mongoose.models.ChatSession || mongoose.model('ChatSession', ChatSessionSchema);


const { makeWASocket, DisconnectReason, initAuthCreds, BufferJSON, proto } = require('@whiskeysockets/baileys');
const { wrapSocket } = require('baileys-antiban');
const pino = require('pino');
const Groq = require('groq-sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');

async function getDualEngineResponse(incomingText, tenantConfig) {
    let fullPrompt = tenantConfig.catalogData 
        ? `${tenantConfig.aiPrompt}\n\nBusiness Catalog & Prices:\n${tenantConfig.catalogData}`
        : tenantConfig.aiPrompt;

    fullPrompt += `\n\nCRITICAL CONSTRAINTS:
1. You must respond ONLY in English. Do NOT respond in Swahili or any other language under any circumstances. Stick strictly to English.
2. When presenting lists, prices, options, or data, do NOT use markdown tables or raw charts. Instead, format them as clean, professional bulleted lists (bulletin points) that are easy to read on mobile devices. Ensure they are professionally structured.`;

    try {
        const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
        const chatCompletion = await groq.chat.completions.create({
            messages: [
                { role: 'system', content: fullPrompt },
                { role: 'user', content: incomingText }
            ],
            model: 'llama-3.3-70b-versatile',
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

// Helper to validate Activation Codes
function validateActivationCode(code) {
    if (!code) return false;
    const clean = code.trim().toUpperCase();
    const validCodes = ['ACT-1234', 'ACT-5678', 'ACT-9999', 'ACT-ABCD', 'ACT-TENANT'];
    return validCodes.includes(clean) || /^ACT-[0-9A-Z]{4}$/.test(clean);
}

// --- BAILEYS SESSION TRIGGER (INTERCEPTED FOR PHONE PAIRING GATEWAY) ---
async function initializeBaileysSession(tenantId, phoneNumber = null) {
    console.log(`Starting Baileys session engine for tenant: ${tenantId}`);
    
    // Clear any stale session first if we are initializing a new one
    if (activeSessions.has(tenantId)) {
        try {
            const oldSession = activeSessions.get(tenantId);
            oldSession.sock.ev.removeAllListeners();
        } catch (e) {}
        activeSessions.delete(tenantId);
    }

    const { state, saveCreds } = await useMongoDBAuthState(tenantId);
    
    const rawSock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        syncFullHistory: false,
        generateHighQualityLinkPreviews: false,
        browser: ["Ubuntu", "Chrome", "20.0.04"]
    });

    const sock = wrapSocket(rawSock, {
        sessionStability: { 
            enabled: true, 
            healthMonitoring: true 
        },
        reconnectThrottle: {
            enabled: true,
            rampDurationMs: 60_000 
        }
    });

    activeSessions.set(tenantId, { sock, status: 'connecting', pairingCode: null });
    await TenantConfig.findOneAndUpdate({ tenantId }, { botStatus: 'connecting' }, { upsert: true });

    sock.ev.on('creds.update', saveCreds);

    // Intercept flow for requestPairingCode(phoneNumber)
    if (phoneNumber && !sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                const cleanPhone = phoneNumber.replace(/[^0-9]/g, '');
                console.log(`Requesting pairing code for ${cleanPhone} on tenant ${tenantId}`);
                let code;
                if (typeof sock.requestPairingCode === 'function') {
                    code = await sock.requestPairingCode(cleanPhone);
                } else {
                    code = await rawSock.requestPairingCode(cleanPhone);
                }
                
                const session = activeSessions.get(tenantId);
                if (session) {
                    session.pairingCode = code;
                    activeSessions.set(tenantId, session);
                }
                
                await TenantConfig.findOneAndUpdate({ tenantId }, { whatsappNumber: cleanPhone });
                console.log(`Pairing code successfully generated for ${tenantId}: ${code}`);
            } catch (err) {
                console.error(`Failed to request pairing code for tenant ${tenantId}:`, err);
            }
        }, 1500); // Small buffer to ensure socket registers with WA servers
    }

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        
        let sessionData = activeSessions.get(tenantId);
        if (!sessionData) return;

        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error)?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log(`Connection closed for ${tenantId}. Status: ${statusCode}. Reconnecting: ${shouldReconnect}`);
            
            if (shouldReconnect) {
                initializeBaileysSession(tenantId);
            } else {
                // Permanent Logout - Rigorous database teardown to prevent orphaned data
                console.log(`Rigorous database cleanup on logout for tenant: ${tenantId}`);
                activeSessions.delete(tenantId);
                const deletedAuth = await AuthState.deleteMany({ tenantId });
                const deletedConfig = await TenantConfig.deleteOne({ tenantId });
                console.log(`Cleanup summary for ${tenantId}: AuthState deleted: ${deletedAuth.deletedCount}, TenantConfig deleted: ${deletedConfig.deletedCount}`);
            }
        } else if (connection === 'open') {
            console.log(`Connection opened successfully for ${tenantId}`);
            sessionData.status = 'connected';
            sessionData.pairingCode = null;
            activeSessions.set(tenantId, sessionData);
            
            const userJid = sock.user?.id?.replace(/:\d+/, '');
            const cleanNumber = userJid ? userJid.split('@')[0] : null;
            await TenantConfig.findOneAndUpdate({ tenantId }, { botStatus: 'connected', whatsappNumber: cleanNumber });
            
            try {
                if (userJid) {
                    const welcomeMsg = `🎉 *Bot Connected Successfully!*\n\n` +
                                       `Your bot is now live. You can configure it right here using the following commands:\n\n` +
                                       `*1.* \`/setbiz <business name>\` - Set your business name.\n` +
                                       `*2.* \`/setprompt <your instructions>\` - Set the AI's behavior.\n` +
                                       `*3.* \`/setfallback <your message>\` - Set the fallback message for deterministic mode or AI failures.\n` +
                                       `*4.* \`/setcatalog <items/prices>\` - Provide your catalog to the AI.\n` +
                                       `*5.* \`/status\` - Check current bot configurations.\n\n` +
                                       `💡 *AI Control Guidelines:*\n` +
                                       `- Users can send \`/stop\` to stop the AI agent from continuing the discussion.\n` +
                                       `- Users can send \`/reset\` to choose between Business/Personal again.\n` +
                                       `- You (the owner) can stop the AI by typing \`.\` in any chat.\n` +
                                       `- You can prompt the AI to continue/resume by typing \`..\` in that chat.\n` +
                                       `- You can type \`/reset\` in any chat to reset its categorization.\n\n` +
                                       `Type any of these commands to get started!`;
                    await sock.sendMessage(userJid, { text: welcomeMsg });
                }
            } catch (err) {
                console.error(`Failed to send welcome message to owner of tenant ${tenantId}:`, err);
            }
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify') return;
        const msg = m.messages[0];
        if (!msg.message) return;

        let incomingText = msg.message.conversation || msg.message.extendedTextMessage?.text;
        if (!incomingText) return;
        incomingText = incomingText.trim();

        const remoteJid = msg.key.remoteJid;
        if (!remoteJid || (!remoteJid.endsWith('@s.whatsapp.net') && !remoteJid.endsWith('@lid'))) return;

        try {
            let config = await TenantConfig.findOne({ tenantId });
            if (!config) return; // Ignore if config was wiped

            // 1. Intercept Categorization Reset Command (accessible by both owner and user)
            if (incomingText.toLowerCase() === '/reset') {
                await ChatSession.updateOne({ tenantId, chatJid: remoteJid }, { category: 'undetermined', greeted: false });
                const displayName = config.businessName || 'AgencyOS';
                const resetMsg = `🔄 Conversation categorization has been reset. Please select the category:\n*1* - Business\n*2* - Personal`;
                await sock.sendMessage(remoteJid, { text: resetMsg });
                await sock.readMessages([msg.key]);
                return;
            }

            // 2. Check Owner Controls (typing . or ..)
            if (msg.key.fromMe) {
                if (incomingText === '.') {
                    await PausedChat.findOneAndUpdate(
                        { tenantId, chatJid: remoteJid },
                        { tenantId, chatJid: remoteJid },
                        { upsert: true }
                    );
                    await sock.sendMessage(remoteJid, { text: '⏸️ AI agent paused for this chat. Type `..` to resume.' });
                    await sock.readMessages([msg.key]);
                    return;
                } else if (incomingText === '..') {
                    await PausedChat.deleteOne({ tenantId, chatJid: remoteJid });
                    await sock.sendMessage(remoteJid, { text: '▶️ AI agent resumed for this chat.' });
                    await sock.readMessages([msg.key]);
                    return;
                }

                // If it's configuration command starting with '/'
                if (incomingText.startsWith('/')) {
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
                }
                return; // Owner outgoing messages should not trigger response flow
            }

            // 3. Check User (Client) Controls (/stop, /start, /resume)
            if (!msg.key.fromMe) {
                const lowerText = incomingText.toLowerCase();
                if (lowerText === '/stop') {
                    await PausedChat.findOneAndUpdate(
                        { tenantId, chatJid: remoteJid },
                        { tenantId, chatJid: remoteJid },
                        { upsert: true }
                    );
                    await sock.sendMessage(remoteJid, { text: '⏸️ The AI agent has been stopped for this discussion. You or the bot owner can explicitly resume it.' }, { quoted: msg });
                    await sock.readMessages([msg.key]);
                    return;
                } else if (lowerText === '/start' || lowerText === '/resume') {
                    await PausedChat.deleteOne({ tenantId, chatJid: remoteJid });
                    await sock.sendMessage(remoteJid, { text: '▶️ The AI agent has resumed.' }, { quoted: msg });
                    await sock.readMessages([msg.key]);
                    return;
                }

                // 4. If chat is paused, ignore other messages from the user
                const isPaused = await PausedChat.findOne({ tenantId, chatJid: remoteJid });
                if (isPaused) {
                    console.log(`[Message Interceptor] Chat ${remoteJid} is paused. AI will not respond.`);
                    return;
                }

                // 5. Manage Chat Categorization (Business vs Personal)
                let session = await ChatSession.findOne({ tenantId, chatJid: remoteJid });
                if (!session) {
                    session = await ChatSession.create({ tenantId, chatJid: remoteJid, category: 'undetermined' });
                }

                if (session.category === 'undetermined') {
                    const lowerInput = incomingText.toLowerCase();
                    if (lowerInput === '1' || lowerInput.includes('business')) {
                        await ChatSession.updateOne({ tenantId, chatJid: remoteJid }, { category: 'business', greeted: true });
                        const displayName = config.businessName || 'AgencyOS';
                        const confirmMsg = `Hi, I am ${displayName} AI agent, I can help you with. How can I help you today?\n\n(Note: You can send /stop at any time to stop this AI agent from continuing this discussion)`;
                        await sock.sendMessage(remoteJid, { text: confirmMsg }, { quoted: msg });
                        await sock.readMessages([msg.key]);
                        return;
                    } else if (lowerInput === '2' || lowerInput.includes('personal')) {
                        await ChatSession.updateOne({ tenantId, chatJid: remoteJid }, { category: 'personal' });
                        const busyMsg = `This is a personal chat. I am currently busy, but I will get back to you shortly.`;
                        await sock.sendMessage(remoteJid, { text: busyMsg }, { quoted: msg });
                        await sock.readMessages([msg.key]);
                        return;
                    } else {
                        // Resend the choice prompt
                        const displayName = config.businessName || 'AgencyOS';
                        const selectMsg = `Hi, I am ${displayName} AI agent. 🤖\n\nIs this a business or personal conversation? Please reply with:\n*1* - Business\n*2* - Personal`;
                        await sock.sendMessage(remoteJid, { text: selectMsg }, { quoted: msg });
                        await sock.readMessages([msg.key]);
                        return;
                    }
                }

                if (session.category === 'personal') {
                    console.log(`[Message Interceptor] Chat ${remoteJid} is categorized as personal. Ignoring.`);
                    return;
                }
            }

            let responseText = '';

            if (config?.engineMode === 'ai') {
                await sock.sendPresenceUpdate('composing', remoteJid);
                responseText = await getDualEngineResponse(incomingText, config);
            } else {
                responseText = config?.fallbackMessage || 'We are currently busy. We will get back to you shortly.';
            }
            
            await sock.readMessages([msg.key]);
            if (responseText && responseText.trim() !== '') {
                // Convert double asterisks to single asterisks for proper WhatsApp bolding
                const formattedResponse = responseText.replace(/\*\*/g, '*');
                await sock.sendMessage(remoteJid, { text: formattedResponse }, { quoted: msg });
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
            pairingCode: liveSession ? liveSession.pairingCode : null
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 2. Initiate WhatsApp Connection Link
app.post('/api/sessions/initiate', async (req, res) => {
    try {
        const { tenantId, phoneNumber, activationCode = 'ACT-TENANT' } = req.body;
        if (!tenantId) return res.status(400).json({ error: 'Tenant ID is required' });
        if (!phoneNumber) return res.status(400).json({ error: 'Phone number is required' });

        if (!validateActivationCode(activationCode)) {
            return res.status(400).json({ error: 'Invalid Activation Code. Expected format: ACT-XXXX' });
        }

        let normalizedPhone = phoneNumber.toString().replace(/\D/g, '');
        if (normalizedPhone.startsWith('0') && normalizedPhone.length === 10) {
            normalizedPhone = '254' + normalizedPhone.substring(1);
        } else if ((normalizedPhone.startsWith('7') || normalizedPhone.startsWith('1')) && normalizedPhone.length === 9) {
            normalizedPhone = '254' + normalizedPhone;
        }

        if (activeSessions.has(tenantId)) {
            try { 
                const session = activeSessions.get(tenantId);
                session.sock.ev.removeAllListeners();
                session.sock.logout(); 
            } catch (e) {}
            activeSessions.delete(tenantId);
        }

        await initializeBaileysSession(tenantId, normalizedPhone);
        res.json({ success: true, message: 'Session initialization triggered. Requesting pairing code.' });
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

// 4. Terminate / Stop Bot Session & Purge Database Configurations (Rigorous Teardown)
app.post('/api/sessions/stop', async (req, res) => {
    try {
        const { tenantId } = req.body;
        
        if (activeSessions.has(tenantId)) {
            try { 
                const session = activeSessions.get(tenantId);
                session.sock.ev.removeAllListeners();
                session.sock.logout(); 
            } catch (e) {}
            activeSessions.delete(tenantId);
        }

        // Wipe AuthState and TenantConfig permanently to prevent orphaned config
        console.log(`Rigorous database cleanup on explicit stop for tenant: ${tenantId}`);
        const deletedAuth = await AuthState.deleteMany({ tenantId });
        const deletedConfig = await TenantConfig.deleteOne({ tenantId });
        console.log(`Purge summary: AuthState deleted docs: ${deletedAuth.deletedCount}, TenantConfig deleted docs: ${deletedConfig.deletedCount}`);

        res.json({ success: true, message: 'Session terminated and configurations purged successfully.' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --- API KEEP-ALIVE MONITOR ---
// Lightweight background interval to ping Groq and Gemini every 5 minutes to keep pools warm
setInterval(() => {
    console.log('[Keep-Alive Monitor] Routine ping to external AI endpoints...');
    
    // Ping Groq API endpoint
    https.get('https://api.groq.com/openai/v1/models', {
        headers: { 'Authorization': `Bearer ${process.env.GROQ_API_KEY || ''}` }
    }, (res) => {
        console.log(`[Keep-Alive Monitor] Groq Ping status: ${res.statusCode}`);
    }).on('error', (err) => {
        console.error('[Keep-Alive Monitor] Groq Ping error:', err.message);
    });

    // Ping Gemini API endpoint
    https.get(`https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY || ''}`, (res) => {
        console.log(`[Keep-Alive Monitor] Gemini Ping status: ${res.statusCode}`);
    }).on('error', (err) => {
        console.error('[Keep-Alive Monitor] Gemini Ping error:', err.message);
    });
}, 5 * 60 * 1000); // 5 minutes

async function autoReconnectActiveSessions() {
    try {
        console.log('[Auto-Reconnect] Checking for active bot sessions to restore...');
        const activeConfigs = await TenantConfig.find({ 
            botStatus: { $in: ['connected', 'connecting'] } 
        });
        
        console.log(`[Auto-Reconnect] Found ${activeConfigs.length} active sessions to restore.`);
        for (const config of activeConfigs) {
            console.log(`[Auto-Reconnect] Restoring session for tenant: ${config.tenantId}`);
            initializeBaileysSession(config.tenantId).catch(err => {
                console.error(`[Auto-Reconnect] Failed to restore session for tenant ${config.tenantId}:`, err);
            });
        }
    } catch (err) {
        console.error('[Auto-Reconnect] Error during auto-reconnection loop:', err);
    }
}

// Database and Server Connect (Supporting both MONGODB_URI and MONGO_URI with placeholder fallback)
let dbUri = process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/agency-os';
if (dbUri.includes('<db_username>')) {
    console.log('[Database] MONGODB_URI placeholder detected. Falling back to local MongoDB.');
    dbUri = 'mongodb://127.0.0.1:27017/agency-os';
}
mongoose.connect(dbUri)
    .then(() => {
        app.listen(PORT, () => {
            console.log(`Agency API engine actively running on port ${PORT}`);
            console.log(`Connected to Database: ${dbUri.substring(0, dbUri.indexOf('@') > -1 ? dbUri.indexOf('@') : 30)}...`);
            autoReconnectActiveSessions();
        });
    })
    .catch(err => console.error('Database connection crash:', err));