const axios = require('axios');

if (!global.mediaLibrary) global.mediaLibrary = [];
if (!global.scraperConfig) global.scraperConfig = { accounts: [], intervalHours: 1, enabled: false, lastRun: null };

async function getInstagramData(username) {
    const response = await axios.get(
        `https://i.instagram.com/api/v1/users/web_profile_info/?username=${username}`,
        {
            headers: {
                'User-Agent': 'Instagram 219.0.0.12.117 Android',
                'X-IG-App-ID': '936619743392459'
            },
            timeout: 15000
        }
    );
    return response.data?.data?.user;
}

function addToLibrary(posts, accountUsername) {
    let newCount = 0;
    const now = new Date().toISOString();
    
    posts.forEach(post => {
        if (!global.mediaLibrary.find(item => item.id === post.id)) {
            global.mediaLibrary.unshift({
                ...post,
                libraryId: `lib_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                importedAt: now,
                sourceAccount: accountUsername,
                used: false
            });
            newCount++;
        }
    });
    
    global.mediaLibrary.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
    if (global.mediaLibrary.length > 500) global.mediaLibrary = global.mediaLibrary.slice(0, 500);
    
    return newCount;
}

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') return res.status(200).end();
    
    if (global.scraperConfig.accounts.length === 0) {
        return res.json({ success: false, message: 'No accounts configured' });
    }
    
    const results = [];
    let totalNewPosts = 0;
    
    for (const account of global.scraperConfig.accounts) {
        try {
            const user = await getInstagramData(account.username);
            
            if (user && !user.is_private) {
                const posts = (user.edge_owner_to_timeline_media?.edges || []).map(edge => ({
                    id: edge.node.id,
                    shortcode: edge.node.shortcode,
                    displayUrl: edge.node.display_url,
                    thumbnailUrl: edge.node.thumbnail_src || edge.node.display_url,
                    caption: edge.node.edge_media_to_caption?.edges?.[0]?.node?.text || '',
                    likes: edge.node.edge_liked_by?.count || edge.node.edge_media_preview_like?.count || 0,
                    comments: edge.node.edge_media_to_comment?.count || 0,
                    timestamp: edge.node.taken_at_timestamp,
                    date: new Date(edge.node.taken_at_timestamp * 1000).toISOString(),
                    isVideo: edge.node.is_video
                }));
                
                const newCount = addToLibrary(posts, account.username);
                totalNewPosts += newCount;
                results.push({ account: account.username, success: true, newPosts: newCount });
            } else {
                results.push({ account: account.username, success: false, error: 'Private or not found' });
            }
        } catch (error) {
            results.push({ account: account.username, success: false, error: error.message });
        }
    }
    
    global.scraperConfig.lastRun = new Date().toISOString();
    
    return res.json({
        success: true,
        timestamp: global.scraperConfig.lastRun,
        results,
        totalNewPosts,
        librarySize: global.mediaLibrary.length
    });
};
