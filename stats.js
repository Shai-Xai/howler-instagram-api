if (!global.mediaLibrary) global.mediaLibrary = [];
if (!global.scraperConfig) global.scraperConfig = { accounts: [], intervalHours: 1, enabled: false, lastRun: null };

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') return res.status(200).end();

    const accounts = [...new Set(global.mediaLibrary.map(i => i.sourceAccount).filter(Boolean))];
    
    return res.json({
        success: true,
        stats: {
            totalItems: global.mediaLibrary.length,
            usedItems: global.mediaLibrary.filter(i => i.used).length,
            accounts: accounts.map(a => ({ 
                username: a, 
                count: global.mediaLibrary.filter(i => i.sourceAccount === a).length 
            })),
            lastImport: global.scraperConfig.lastRun
        }
    });
};
