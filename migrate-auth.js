const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { BufferJSON } = require('@whiskeysockets/baileys');
require('dotenv').config();

const AuthStateSchema = new mongoose.Schema({
    tenantId: { type: String, required: true, index: true },
    key: { type: String, required: true },
    value: { type: String }
});
AuthStateSchema.index({ tenantId: 1, key: 1 }, { unique: true });
const AuthState = mongoose.models.AuthState || mongoose.model('AuthState', AuthStateSchema);

async function migrateAuth(tenantId) {
    const authPath = `./auth_info_${tenantId}`;
    if (!fs.existsSync(authPath)) {
        console.log(`No local auth folder found for ${tenantId}. Nothing to migrate.`);
        return;
    }

    console.log(`Migrating ${tenantId} to MongoDB...`);
    const files = fs.readdirSync(authPath);
    let migratedCount = 0;

    for (const file of files) {
        if (!file.endsWith('.json')) continue;

        let key = file.replace('.json', '');

        try {
            const raw = fs.readFileSync(path.join(authPath, file), 'utf-8');
            const parsed = JSON.parse(raw, BufferJSON.reviver);
            const value = JSON.stringify(parsed, BufferJSON.replacer);

            await AuthState.updateOne({ tenantId, key }, { value }, { upsert: true });
            migratedCount++;
        } catch (err) {
            console.error(`Failed to migrate file ${file}:`, err);
        }
    }

    console.log(`Successfully migrated ${migratedCount} keys for ${tenantId} to MongoDB!`);
    console.log(`You can now safely delete the ${authPath} folder.`);
}

async function main() {
    try {
        await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/agency-os');
        console.log('Connected to MongoDB.');
        
        const dirs = fs.readdirSync('.').filter(f => f.startsWith('auth_info_') && fs.statSync(f).isDirectory());
        
        if (dirs.length === 0) {
            console.log('No auth_info folders found to migrate.');
        }

        for (const dir of dirs) {
            const tenantId = dir.replace('auth_info_', '');
            await migrateAuth(tenantId);
        }

    } catch (err) {
        console.error('Migration failed:', err);
    } finally {
        mongoose.disconnect();
    }
}

main();
