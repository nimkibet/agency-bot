// backend/src/index.js
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

const { makeWASocket, DisconnectReason, initAuthCreds, BufferJSON, proto, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcodeTerminal = require('qrcode-terminal');

const app = express();
const PORT = process.env.PORT || 5005;

app.use(cors());
app.use(express.json());

// --- MONGOOSE SCHEMAS ---
const AuthStateSchema = new mongoose.Schema({
    tenantId: { type: String, required: true, index: true },
    key: { type: String, required: true },
    value: { type: String }
});
AuthStateSchema.index({ tenantId: 1, key: 1 }, { unique: true });
const AuthState = mongoose.models.AuthState || mongoose.model('AuthState', AuthStateSchema);

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

let globalSocket = null;
let currentQR = null;

async function initializeBaileys() {
    const tenantId = 'vegas_pos_main';
    console.log('Starting Baileys session engine for:', tenantId);
    
    const { state, saveCreds } = await useMongoDBAuthState(tenantId);
    
    // Fetch latest WhatsApp version to prevent 405 Outdated Client errors
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`Using WhatsApp v${version.join('.')}, isLatest: ${isLatest}`);
    
    globalSocket = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: true,
        logger: pino({ level: 'silent' }),
        syncFullHistory: false,
        generateHighQualityLinkPreviews: false,
        browser: ["Ubuntu", "Chrome", "20.0.04"]
    });

    globalSocket.ev.on('creds.update', saveCreds);

    globalSocket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            currentQR = qr;
            console.log('\n================== SCAN QR CODE ==================');
            qrcodeTerminal.generate(qr, { small: true });
            console.log('==================================================\n');
        }

        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error)?.output?.statusCode;
            console.log(`Connection closed. Status: ${statusCode}.`);
            
            if (statusCode === 405 || statusCode === DisconnectReason.loggedOut) {
                console.log(`Session corrupt or logged out (Status ${statusCode}). Wiping old data...`);
                await AuthState.deleteMany({ tenantId });
                console.log('Database wiped! Restarting node process to generate fresh QR code...');
                process.exit(1); // Force PM2 to cleanly restart with empty DB
            } else {
                console.log('Reconnecting gracefully...');
            }
        } else if (connection === 'open') {
            console.log('Connection opened successfully.');
            currentQR = null;
            
            // Auto-fetch groups to display JIDs in console
            setTimeout(async () => {
                try {
                    console.log('Scanning for groups named "Vegas"...');
                    const groups = await globalSocket.groupFetchAllParticipating();
                    let found = false;
                    Object.values(groups).forEach(g => {
                        if (g.subject.toLowerCase().includes('vegas')) {
                            console.log(`\n🟢 FOUND GROUP! 🟢\nName: ${g.subject}\nJID:  ${g.id}\nCopy this JID into your .env file!\n`);
                            found = true;
                        }
                    });
                    if (!found) console.log('No groups with "Vegas" in the name were found.');
                } catch (err) {
                    console.error('Failed to fetch groups:', err);
                }
            }, 3000);
        }
    });
}

// --- API ROUTES ---

app.get('/api/groups', async (req, res) => {
    if (!globalSocket) {
        return res.status(503).json({ error: 'WhatsApp socket not initialized' });
    }
    try {
        const groups = await globalSocket.groupFetchAllParticipating();
        const groupList = Object.values(groups).map(g => ({ id: g.id, name: g.subject }));
        
        const searchName = req.query.name;
        if (searchName) {
            const filtered = groupList.filter(g => g.name && g.name.toLowerCase().includes(searchName.toLowerCase()));
            return res.json(filtered);
        }
        
        res.json(groupList);
    } catch (err) {
        console.error('Error fetching groups:', err);
        res.status(500).json({ error: 'Failed to fetch groups' });
    }
});

app.post('/webhook/pos-event', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || authHeader !== process.env.WEBHOOK_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!globalSocket) {
        return res.status(503).json({ error: 'WhatsApp socket not initialized' });
    }

    const targetGroupJid = process.env.TARGET_GROUP_JID;
    if (!targetGroupJid) {
        return res.status(500).json({ error: 'TARGET_GROUP_JID not configured' });
    }

    const payload = req.body;
    if (!payload || payload.type !== 'INSERT') {
        return res.status(400).json({ error: 'Invalid or unsupported payload type. Expected INSERT.' });
    }

    try {
        const table = payload.table;
        const record = payload.record || {};
        let messageText = null;

        if (table === 'supplier_transactions') {
            const cashPaid = record.cash_paid || 0;
            const debtorOffset = record.debtor_offset || 0;
            const paymentSource = record.payment_source || 'N/A';
            
            messageText = `📦 *Restock Summary*\n\n` +
                          `*Cash Paid*: ${cashPaid}\n` +
                          `*Debtor Offset*: ${debtorOffset}\n` +
                          `*Payment Source*: ${paymentSource}`;
                          
        } else if (table === 'shifts' && record.status === 'CLOSED') {
            const expectedCash = record.expected_cash || 0;
            const actualCash = record.actual_cash || 0;
            const startingFloat = record.starting_float || 0;
            const diff = actualCash - expectedCash;
            const statusIcon = diff >= 0 ? '✅' : '⚠️';
            
            messageText = `🏁 *End of Day Summary*\n\n` +
                          `*Starting Float*: ${startingFloat}\n` +
                          `*Expected Cash*: ${expectedCash}\n` +
                          `*Actual Cash*: ${actualCash}\n` +
                          `*Difference*: ${diff} ${statusIcon}`;
        }

        if (messageText) {
            await globalSocket.sendMessage(targetGroupJid, { text: messageText });
            return res.status(200).json({ success: true, message: 'Notification sent to WhatsApp' });
        } else {
            return res.status(200).json({ success: true, message: 'Event ignored based on conditions' });
        }
    } catch (err) {
        console.error('Error sending message:', err);
        return res.status(500).json({ error: 'Failed to send WhatsApp message' });
    }
});

// Database and Server Connect
let dbUri = process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/agency-os';
mongoose.connect(dbUri)
    .then(() => {
        app.listen(PORT, () => {
            console.log(`Webhook bridge listening on port ${PORT}`);
            initializeBaileys();
        });
    })
    .catch(err => console.error('Database connection crash:', err));