// Howler Instagram API v7 - with Clerk authentication

const { verifyToken } = require('@clerk/backend');

module.exports = async function(req, res) {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    var url = req.url || '/';
    var path = url.split('?')[0];

    // Public routes
    var isPublic = path === '/' || path === '' || path === '/api/proxy/image';

    var orgId = null;

    if (!isPublic) {
        var authHeader = req.headers['authorization'];
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        var token = authHeader.slice(7);

        try {
            var payload = await verifyToken(token, { secretKey: process.env.CLERK_SECRET_KEY });
            orgId = payload.org_id;

            if (!orgId) {
                return res.status(403).json({ error: 'No active organisation. Please select an organisation.' });
            }
        } catch (e) {
            return res.status(401).json({ error: 'Invalid token' });
        }
    }

    // Org-scoped in-memory store
    if (!global.orgStores) global.orgStores = {};
    if (orgId && !global.orgStores[orgId]) {
        global.orgStores[orgId] = {
            library: [],
            accounts: [],
            config: { enabled: false, intervalHours: 1, lastRun: null }
        };
    }
    var store = orgId ? global.orgStores[orgId] : null;

    try {
        // Root (public)
        if (path === '/' || path === '') {
            return res.status(200).json({
                status: 'ok',
                message: 'Howler Instagram API v7'
            });
        }

        // Library stats
        if (path === '/api/library/stats') {
            var accountList = [];
            for (var i = 0; i < store.library.length; i++) {
                var acc = store.library[i].sourceAccount;
                if (acc && accountList.indexOf(acc) === -1) accountList.push(acc);
            }
            return res.status(200).json({
                success: true,
                stats: {
                    totalItems: store.library.length,
                    usedItems: store.library.filter(function(i) { return i.used; }).length,
                    accounts: accountList.map(function(a) {
                        return {
                            username: a,
                            count: store.library.filter(function(i) { return i.sourceAccount === a; }).length
                        };
                    }),
                    lastImport: store.config.lastRun
                }
            });
        }

        // Library list
        if (path === '/api/library') {
            var query = req.query || {};
            var filtered = store.library.slice();

            if (query.account) filtered = filtered.filter(function(i) { return i.sourceAccount === query.account; });
            if (query.used !== undefined) filtered = filtered.filter(function(i) { return i.used === (query.used === 'true'); });

            var page = parseInt(query.page) || 1;
            var limit = parseInt(query.limit) || 50;
            var start = (page - 1) * limit;

            return res.status(200).json({
                success: true,
                data: filtered.slice(start, start + limit),
                pagination: {
                    page: page,
                    limit: limit,
                    total: filtered.length,
                    totalPages: Math.ceil(filtered.length / limit) || 1
                }
            });
        }

        // Scraper config
        if (path === '/api/scraper/config') {
            if (req.method === 'POST' && req.body) {
                if (typeof req.body.enabled === 'boolean') store.config.enabled = req.body.enabled;
                if (req.body.intervalHours) store.config.intervalHours = req.body.intervalHours;
            }
            return res.status(200).json({
                success: true,
                config: {
                    accounts: store.accounts,
                    enabled: store.config.enabled,
                    intervalHours: store.config.intervalHours,
                    lastRun: store.config.lastRun
                }
            });
        }

        // Scraper accounts - GET
        if (path === '/api/scraper/accounts' && req.method === 'GET') {
            return res.status(200).json({ success: true, accounts: store.accounts });
        }

        // Scraper accounts - POST
        if (path === '/api/scraper/accounts' && req.method === 'POST') {
            var body = req.body || {};
            var username = (body.username || '').trim().replace(/^@/, '');

            if (!username) return res.status(400).json({ success: false, error: 'Username required' });

            for (var i = 0; i < store.accounts.length; i++) {
                if (store.accounts[i].username === username) {
                    return res.status(400).json({ success: false, error: 'Already added' });
                }
            }

            var igResult = await fetchInstagramProfile(username);
            if (!igResult.success) return res.status(400).json({ success: false, error: igResult.error });

            var user = igResult.user;
            if (user.is_private) return res.status(400).json({ success: false, error: 'Private account' });

            store.accounts.push({
                username: user.username,
                fullName: user.full_name || '',
                profilePic: user.profile_pic_url_hd || user.profile_pic_url || '',
                followers: (user.edge_followed_by && user.edge_followed_by.count) || 0,
                addedAt: new Date().toISOString()
            });

            var newCount = addPostsToLibrary(store, user, username);

            return res.status(200).json({
                success: true,
                message: 'Added @' + username + ' (' + newCount + ' posts)',
                config: {
                    accounts: store.accounts,
                    enabled: store.config.enabled,
                    intervalHours: store.config.intervalHours,
                    lastRun: store.config.lastRun
                }
            });
        }

        // Scraper run
        if (path === '/api/scraper/run' && req.method === 'POST') {
            if (store.accounts.length === 0) {
                return res.status(200).json({ success: false, message: 'No accounts configured' });
            }

            var totalNewPosts = 0;
            var results = [];

            for (var a = 0; a < store.accounts.length; a++) {
                var account = store.accounts[a];
                try {
                    var igResult = await fetchInstagramProfile(account.username);
                    if (igResult.success && igResult.user && !igResult.user.is_private) {
                        var newCount = addPostsToLibrary(store, igResult.user, account.username);
                        totalNewPosts += newCount;
                        results.push({ account: account.username, success: true, newPosts: newCount });
                    } else {
                        results.push({ account: account.username, success: false, error: igResult.error || 'Not found or private' });
                    }
                } catch (err) {
                    results.push({ account: account.username, success: false, error: err.message });
                }
            }

            store.config.lastRun = new Date().toISOString();

            return res.status(200).json({
                success: true,
                results: results,
                totalNewPosts: totalNewPosts,
                librarySize: store.library.length
            });
        }

        // Instagram fetch
        if (path.indexOf('/api/instagram/') === 0) {
            var username = path.replace('/api/instagram/', '');
            username = decodeURIComponent(username).trim().replace(/^@/, '');

            var igResult = await fetchInstagramProfile(username);
            if (!igResult.success) return res.status(400).json({ success: false, error: igResult.error });

            var user = igResult.user;
            var postsList = (user.edge_owner_to_timeline_media && user.edge_owner_to_timeline_media.edges) || [];
            var formattedPosts = [];

            for (var i = 0; i < postsList.length; i++) {
                var node = postsList[i].node;
                formattedPosts.push({
                    id: node.id,
                    displayUrl: node.display_url,
                    thumbnailUrl: node.thumbnail_src || node.display_url,
                    caption: getCaption(node),
                    likes: getLikes(node),
                    comments: (node.edge_media_to_comment && node.edge_media_to_comment.count) || 0,
                    isVideo: node.is_video
                });
            }

            return res.status(200).json({
                success: true,
                profile: {
                    username: user.username,
                    fullName: user.full_name || '',
                    bio: user.biography || '',
                    profilePic: user.profile_pic_url_hd || user.profile_pic_url || '',
                    followers: (user.edge_followed_by && user.edge_followed_by.count) || 0,
                    following: (user.edge_follow && user.edge_follow.count) || 0,
                    postsCount: (user.edge_owner_to_timeline_media && user.edge_owner_to_timeline_media.count) || 0,
                    isPrivate: user.is_private,
                    isVerified: user.is_verified
                },
                posts: formattedPosts
            });
        }

        // Image proxy (public)
        if (path === '/api/proxy/image') {
            var imageUrl = req.query && req.query.url;
            if (!imageUrl) return res.status(400).json({ error: 'URL required' });

            try {
                var imgResponse = await fetch(imageUrl, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                    }
                });
                var buffer = await imgResponse.arrayBuffer();
                var contentType = imgResponse.headers.get('content-type') || 'image/jpeg';
                res.setHeader('Content-Type', contentType);
                res.setHeader('Cache-Control', 'public, max-age=86400');
                return res.send(Buffer.from(buffer));
            } catch (e) {
                return res.status(500).json({ error: 'Failed to fetch image' });
            }
        }

        // Library mark used
        if (path.indexOf('/api/library/mark-used/') === 0 && req.method === 'POST') {
            var id = path.replace('/api/library/mark-used/', '');
            var item = null;
            for (var i = 0; i < store.library.length; i++) {
                if (store.library[i].libraryId === id || store.library[i].id === id) {
                    item = store.library[i];
                    break;
                }
            }
            if (!item) return res.status(404).json({ success: false, error: 'Not found' });
            item.used = true;
            return res.status(200).json({ success: true, item: item });
        }

        // Library delete
        if (path.indexOf('/api/library/') === 0 && req.method === 'DELETE') {
            var id = path.replace('/api/library/', '');
            var idx = -1;
            for (var i = 0; i < store.library.length; i++) {
                if (store.library[i].libraryId === id || store.library[i].id === id) {
                    idx = i;
                    break;
                }
            }
            if (idx === -1) return res.status(404).json({ success: false, error: 'Not found' });
            store.library.splice(idx, 1);
            return res.status(200).json({ success: true });
        }

        // Scraper accounts delete
        if (path.indexOf('/api/scraper/accounts/') === 0 && req.method === 'DELETE') {
            var username = path.replace('/api/scraper/accounts/', '');
            var idx = -1;
            for (var i = 0; i < store.accounts.length; i++) {
                if (store.accounts[i].username === username) {
                    idx = i;
                    break;
                }
            }
            if (idx === -1) return res.status(404).json({ success: false, error: 'Not found' });
            store.accounts.splice(idx, 1);
            return res.status(200).json({
                success: true,
                config: {
                    accounts: store.accounts,
                    enabled: store.config.enabled,
                    intervalHours: store.config.intervalHours,
                    lastRun: store.config.lastRun
                }
            });
        }

        return res.status(404).json({ error: 'Not found', path: path });

    } catch (error) {
        console.error('API Error:', error);
        return res.status(500).json({ success: false, error: error.message, path: path });
    }
};

async function fetchInstagramProfile(username) {
    var methods = [fetchViaWebProfileInfo, fetchViaGraphQL];
    for (var i = 0; i < methods.length; i++) {
        try {
            var result = await methods[i](username);
            if (result.success) return result;
        } catch (e) {}
    }
    return { success: false, error: 'Could not fetch Instagram data. Instagram may be blocking requests.' };
}

async function fetchViaWebProfileInfo(username) {
    var response = await fetch(
        'https://i.instagram.com/api/v1/users/web_profile_info/?username=' + encodeURIComponent(username),
        {
            headers: {
                'User-Agent': 'Instagram 275.0.0.27.98 Android (33/13; 420dpi; 1080x2400; samsung; SM-G991B; o1s; exynos2100; en_US; 458229237)',
                'X-IG-App-ID': '936619743392459',
                'X-IG-WWW-Claim': '0',
                'X-Requested-With': 'XMLHttpRequest',
                'Accept': 'application/json'
            }
        }
    );
    var text = await response.text();
    if (!text.startsWith('{')) return { success: false, error: 'Instagram returned non-JSON response' };
    var data = JSON.parse(text);
    var user = data && data.data && data.data.user;
    if (!user) return { success: false, error: 'User not found' };
    return { success: true, user: user };
}

async function fetchViaGraphQL(username) {
    var response = await fetch(
        'https://www.instagram.com/api/v1/users/web_profile_info/?username=' + encodeURIComponent(username),
        {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'X-IG-App-ID': '936619743392459',
                'X-Requested-With': 'XMLHttpRequest',
                'Accept': 'application/json'
            }
        }
    );
    var text = await response.text();
    if (!text.startsWith('{')) return { success: false, error: 'Instagram returned non-JSON response' };
    var data = JSON.parse(text);
    var user = data && data.data && data.data.user;
    if (!user) return { success: false, error: 'User not found' };
    return { success: true, user: user };
}

function addPostsToLibrary(store, user, username) {
    var posts = (user.edge_owner_to_timeline_media && user.edge_owner_to_timeline_media.edges) || [];
    var newCount = 0;
    for (var i = 0; i < posts.length; i++) {
        var node = posts[i].node;
        var exists = false;
        for (var j = 0; j < store.library.length; j++) {
            if (store.library[j].id === node.id) { exists = true; break; }
        }
        if (!exists) {
            store.library.unshift({
                id: node.id,
                libraryId: 'lib_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
                displayUrl: node.display_url,
                thumbnailUrl: node.thumbnail_src || node.display_url,
                caption: getCaption(node),
                likes: getLikes(node),
                comments: (node.edge_media_to_comment && node.edge_media_to_comment.count) || 0,
                isVideo: node.is_video,
                sourceAccount: username,
                importedAt: new Date().toISOString(),
                used: false
            });
            newCount++;
        }
    }
    return newCount;
}

function getCaption(node) {
    if (node.edge_media_to_caption &&
        node.edge_media_to_caption.edges &&
        node.edge_media_to_caption.edges[0] &&
        node.edge_media_to_caption.edges[0].node) {
        return node.edge_media_to_caption.edges[0].node.text || '';
    }
    return '';
}

function getLikes(node) {
    if (node.edge_liked_by && node.edge_liked_by.count) return node.edge_liked_by.count;
    if (node.edge_media_preview_like && node.edge_media_preview_like.count) return node.edge_media_preview_like.count;
    return 0;
}
