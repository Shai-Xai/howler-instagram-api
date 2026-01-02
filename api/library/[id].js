if (!global.mediaLibrary) global.mediaLibrary = [];

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') return res.status(200).end();
    
    const { id } = req.query;
    const idx = global.mediaLibrary.findIndex(i => i.libraryId === id || i.id === id);
    
    if (idx === -1) {
        return res.status(404).json({ success: false, error: 'Not found' });
    }
    
    global.mediaLibrary.splice(idx, 1);
    return res.json({ success: true });
};
