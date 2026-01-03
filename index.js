module.exports = function(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    var path = req.url.split('?')[0];
    
    if (path === '/') {
        return res.status(200).json({ status: 'ok', path: path });
    }
    
    if (path === '/api/library/stats') {
        return res.status(200).json({ success: true, stats: { totalItems: 0 } });
    }
    
    if (path === '/api/scraper/config') {
        return res.status(200).json({ success: true, config: { accounts: [] } });
    }
    
    return res.status(200).json({ path: path, message: 'received' });
};
