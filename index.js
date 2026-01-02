// In-memory storage (shared across endpoints via global)
if (!global.mediaLibrary) global.mediaLibrary = [];
if (!global.scraperConfig) global.scraperConfig = {
    accounts: [],
    intervalHours: 1,
    enabled: false,
    lastRun: null
};

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    const { page = 1, limit = 50, account, used, search, sortBy = 'date', sortOrder = 'desc' } = req.query;
    
    let filtered = [...global.mediaLibrary];
    
    if (account) filtered = filtered.filter(i => i.sourceAccount === account);
    if (used !== undefined) filtered = filtered.filter(i => i.used === (used === 'true'));
    if (search) filtered = filtered.filter(i => i.caption?.toLowerCase().includes(search.toLowerCase()));
    
    filtered.sort((a, b) => {
        const aVal = sortBy === 'likes' ? (a.likes || 0) : new Date(a.date || 0);
        const bVal = sortBy === 'likes' ? (b.likes || 0) : new Date(b.date || 0);
        return sortOrder === 'asc' ? aVal - bVal : bVal - aVal;
    });
    
    const start = (page - 1) * limit;
    
    return res.json({
        success: true,
        data: filtered.slice(start, start + parseInt(limit)),
        pagination: { 
            page: +page, 
            limit: +limit, 
            total: filtered.length, 
            totalPages: Math.ceil(filtered.length / limit) || 1
        }
    });
};
