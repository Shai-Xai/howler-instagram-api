if (!global.mediaLibrary) global.mediaLibrary = [];

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') return res.status(200).end();
    
    const { id } = req.query;
    const item = global.mediaLibrary.find(i => i.libraryId === id || i.id === id);
    
    if (!item) {
        return res.status(404).json({ success: false, error: 'Not found' });
    }
    
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    item.used = body?.used !== false;
    item.usedAt = item.used ? new Date().toISOString() : null;
    
    return res.json({ success: true, item });
};
