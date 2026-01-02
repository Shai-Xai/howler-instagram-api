if (!global.scraperConfig) global.scraperConfig = { accounts: [], intervalHours: 1, enabled: false, lastRun: null };

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') return res.status(200).end();
    
    if (req.method === 'POST') {
        const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
        if (typeof body?.enabled === 'boolean') global.scraperConfig.enabled = body.enabled;
        if (body?.intervalHours >= 0.5) global.scraperConfig.intervalHours = body.intervalHours;
    }
    
    return res.json({ success: true, config: global.scraperConfig });
};
