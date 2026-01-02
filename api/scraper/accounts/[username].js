if (!global.mediaLibrary) global.mediaLibrary = [];
if (!global.scraperConfig) global.scraperConfig = { accounts: [], intervalHours: 1, enabled: false, lastRun: null };

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') return res.status(200).end();
    
    const { username } = req.query;
    const idx = global.scraperConfig.accounts.findIndex(a => a.username === username);
    
    if (idx === -1) {
        return res.status(404).json({ success: false, error: 'Account not found' });
    }
    
    global.scraperConfig.accounts.splice(idx, 1);
    
    // Optionally remove media from this account
    if (req.query.removeMedia === 'true') {
        global.mediaLibrary = global.mediaLibrary.filter(i => i.sourceAccount !== username);
    }
    
    return res.json({ success: true, config: global.scraperConfig });
};
