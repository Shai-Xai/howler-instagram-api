// Howler Instagram API v7 - Clerk auth + Neon Postgres

const { verifyToken } = require('@clerk/backend');
const { sql } = require('@vercel/postgres');

async function initTables() {
    await sql`
        CREATE TABLE IF NOT EXISTS library (
            library_id TEXT PRIMARY KEY,
            id TEXT NOT NULL,
            org_id TEXT NOT NULL,
            display_url TEXT,
            thumbnail_url TEXT,
            caption TEXT,
            likes INTEGER DEFAULT 0,
            comments INTEGER DEFAULT 0,
            is_video BOOLEAN DEFAULT false,
            source_account TEXT,
            imported_at TIMESTAMPTZ DEFAULT NOW(),
            used BOOLEAN DEFAULT false
        )
    `;
    await sql`
        CREATE TABLE IF NOT EXISTS accounts (
            org_id TEXT NOT NULL,
            username TEXT NOT NULL,
            full_name TEXT,
            profile_pic TEXT,
            followers INTEGER DEFAULT 0,
            added_at TIMESTAMPTZ DEFAULT NOW(),
            PRIMARY KEY (org_id, username)
        )
    `;
    await sql`
        CREATE TABLE IF NOT EXISTS scraper_config (
            org_id TEXT PRIMARY KEY,
            enabled BOOLEAN DEFAULT false,
            interval_hours NUMERIC DEFAULT 1,
            last_run TIMESTAMPTZ
        )
    `;
}

module.exports = async function(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') return res.status(200).end();

    var url = req.url || '/';
    var path = url.split('?')[0];
    var isPublic = path === '/' || path === '' || path === '/api/proxy/image';

    var orgId = null;

    if (!isPublic) {
        var authHeader = req.headers['authorization'];
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        try {
            var payload = await verifyToken(authHeader.slice(7), { secretKey: process.env.CLERK_SECRET_KEY });
            orgId = payload.org_id;
            if (!orgId) return res.status(403).json({ error: 'No active organisation.' });
        } catch (e) {
            return res.status(401).json({ error: 'Invalid token' });
        }
    }

    try {
        await initTables();

        // Root
        if (path === '/' || path === '') {
            return res.status(200).json({ status: 'ok', message: 'Howler Instagram API v7' });
        }

        // Library stats
        if (path === '/api/library/stats') {
            const totals = await sql`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE used) as used FROM library WHERE org_id = ${orgId}`;
            const accs = await sql`SELECT source_account, COUNT(*) as count FROM library WHERE org_id = ${orgId} GROUP BY source_account`;
            const cfg = await sql`SELECT last_run FROM scraper_config WHERE org_id = ${orgId}`;
            return res.status(200).json({
                success: true,
                stats: {
                    totalItems: parseInt(totals.rows[0].total),
                    usedItems: parseInt(totals.rows[0].used),
                    accounts: accs.rows.map(r => ({ username: r.source_account, count: parseInt(r.count) })),
                    lastImport: cfg.rows[0]?.last_run || null
                }
            });
        }

        // Library list
        if (path === '/api/library' && req.method !== 'DELETE') {
            var query = req.query || {};
            var page = parseInt(query.page) || 1;
            var limit = parseInt(query.limit) || 50;
            var offset = (page - 1) * limit;

            var rows, countRow;
            if (query.account && query.used !== undefined) {
                var usedBool = query.used === 'true';
                rows = await sql`SELECT * FROM library WHERE org_id = ${orgId} AND source_account = ${query.account} AND used = ${usedBool} ORDER BY imported_at DESC LIMIT ${limit} OFFSET ${offset}`;
                countRow = await sql`SELECT COUNT(*) as total FROM library WHERE org_id = ${orgId} AND source_account = ${query.account} AND used = ${usedBool}`;
            } else if (query.account) {
                rows = await sql`SELECT * FROM library WHERE org_id = ${orgId} AND source_account = ${query.account} ORDER BY imported_at DESC LIMIT ${limit} OFFSET ${offset}`;
                countRow = await sql`SELECT COUNT(*) as total FROM library WHERE org_id = ${orgId} AND source_account = ${query.account}`;
            } else if (query.used !== undefined) {
                var usedBool = query.used === 'true';
                rows = await sql`SELECT * FROM library WHERE org_id = ${orgId} AND used = ${usedBool} ORDER BY imported_at DESC LIMIT ${limit} OFFSET ${offset}`;
                countRow = await sql`SELECT COUNT(*) as total FROM library WHERE org_id = ${orgId} AND used = ${usedBool}`;
            } else {
                rows = await sql`SELECT * FROM library WHERE org_id = ${orgId} ORDER BY imported_at DESC LIMIT ${limit} OFFSET ${offset}`;
                countRow = await sql`SELECT COUNT(*) as total FROM library WHERE org_id = ${orgId}`;
            }

            var total = parseInt(countRow.rows[0].total);
            return res.status(200).json({
                success: true,
                data: rows.rows.map(dbRowToLibItem),
                pagination: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 }
            });
        }

        // Scraper config
        if (path === '/api/scraper/config') {
            if (req.method === 'POST' && req.body) {
                var { enabled, intervalHours } = req.body;
                await sql`
                    INSERT INTO scraper_config (org_id, enabled, interval_hours)
                    VALUES (${orgId}, ${enabled ?? false}, ${intervalHours ?? 1})
                    ON CONFLICT (org_id) DO UPDATE
                    SET enabled = COALESCE(EXCLUDED.enabled, scraper_config.enabled),
                        interval_hours = COALESCE(EXCLUDED.interval_hours, scraper_config.interval_hours)
                `;
            }
            var cfg = await sql`SELECT * FROM scraper_config WHERE org_id = ${orgId}`;
            var accs = await sql`SELECT * FROM accounts WHERE org_id = ${orgId} ORDER BY added_at`;
            return res.status(200).json({
                success: true,
                config: {
                    accounts: accs.rows.map(dbRowToAccount),
                    enabled: cfg.rows[0]?.enabled || false,
                    intervalHours: cfg.rows[0]?.interval_hours || 1,
                    lastRun: cfg.rows[0]?.last_run || null
                }
            });
        }

        // Scraper accounts - GET
        if (path === '/api/scraper/accounts' && req.method === 'GET') {
            var accs = await sql`SELECT * FROM accounts WHERE org_id = ${orgId} ORDER BY added_at`;
            return res.status(200).json({ success: true, accounts: accs.rows.map(dbRowToAccount) });
        }

        // Scraper accounts - POST
        if (path === '/api/scraper/accounts' && req.method === 'POST') {
            var username = ((req.body || {}).username || '').trim().replace(/^@/, '');
            if (!username) return res.status(400).json({ success: false, error: 'Username required' });

            var existing = await sql`SELECT 1 FROM accounts WHERE org_id = ${orgId} AND username = ${username}`;
            if (existing.rows.length > 0) return res.status(400).json({ success: false, error: 'Already added' });

            var igResult = await fetchInstagramProfile(username);
            if (!igResult.success) return res.status(400).json({ success: false, error: igResult.error });

            var user = igResult.user;
            if (user.is_private) return res.status(400).json({ success: false, error: 'Private account' });

            await sql`
                INSERT INTO accounts (org_id, username, full_name, profile_pic, followers)
                VALUES (${orgId}, ${user.username}, ${user.full_name || ''}, ${user.profile_pic_url_hd || user.profile_pic_url || ''}, ${(user.edge_followed_by && user.edge_followed_by.count) || 0})
            `;

            var newCount = await addPostsToDb(orgId, user, user.username);
            var accs = await sql`SELECT * FROM accounts WHERE org_id = ${orgId} ORDER BY added_at`;
            var cfg = await sql`SELECT * FROM scraper_config WHERE org_id = ${orgId}`;

            return res.status(200).json({
                success: true,
                message: 'Added @' + user.username + ' (' + newCount + ' posts)',
                config: {
                    accounts: accs.rows.map(dbRowToAccount),
                    enabled: cfg.rows[0]?.enabled || false,
                    intervalHours: cfg.rows[0]?.interval_hours || 1,
                    lastRun: cfg.rows[0]?.last_run || null
                }
            });
        }

        // Scraper run
        if (path === '/api/scraper/run' && req.method === 'POST') {
            var accs = await sql`SELECT * FROM accounts WHERE org_id = ${orgId}`;
            if (accs.rows.length === 0) return res.status(200).json({ success: false, message: 'No accounts configured' });

            var totalNewPosts = 0;
            var results = [];

            for (var a = 0; a < accs.rows.length; a++) {
                var acc = accs.rows[a];
                try {
                    var igResult = await fetchInstagramProfile(acc.username);
                    if (igResult.success && igResult.user && !igResult.user.is_private) {
                        var newCount = await addPostsToDb(orgId, igResult.user, acc.username);
                        totalNewPosts += newCount;
                        results.push({ account: acc.username, success: true, newPosts: newCount });
                    } else {
                        results.push({ account: acc.username, success: false, error: igResult.error || 'Not found or private' });
                    }
                } catch (err) {
                    results.push({ account: acc.username, success: false, error: err.message });
                }
            }

            await sql`
                INSERT INTO scraper_config (org_id, last_run)
                VALUES (${orgId}, NOW())
                ON CONFLICT (org_id) DO UPDATE SET last_run = NOW()
            `;

            var total = await sql`SELECT COUNT(*) as total FROM library WHERE org_id = ${orgId}`;
            return res.status(200).json({ success: true, results, totalNewPosts, librarySize: parseInt(total.rows[0].total) });
        }

        // Instagram fetch
        if (path.indexOf('/api/instagram/') === 0) {
            var username = decodeURIComponent(path.replace('/api/instagram/', '')).trim().replace(/^@/, '');
            var igResult = await fetchInstagramProfile(username);
            if (!igResult.success) return res.status(400).json({ success: false, error: igResult.error });

            var user = igResult.user;
            var postsList = (user.edge_owner_to_timeline_media && user.edge_owner_to_timeline_media.edges) || [];

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
                posts: postsList.map(function(e) {
                    var node = e.node;
                    return {
                        id: node.id,
                        displayUrl: node.display_url,
                        thumbnailUrl: node.thumbnail_src || node.display_url,
                        caption: getCaption(node),
                        likes: getLikes(node),
                        comments: (node.edge_media_to_comment && node.edge_media_to_comment.count) || 0,
                        isVideo: node.is_video
                    };
                })
            });
        }

        // Image proxy (public)
        if (path === '/api/proxy/image') {
            var imageUrl = req.query && req.query.url;
            if (!imageUrl) return res.status(400).json({ error: 'URL required' });
            try {
                var imgResponse = await fetch(imageUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
                var buffer = await imgResponse.arrayBuffer();
                res.setHeader('Content-Type', imgResponse.headers.get('content-type') || 'image/jpeg');
                res.setHeader('Cache-Control', 'public, max-age=86400');
                return res.send(Buffer.from(buffer));
            } catch (e) {
                return res.status(500).json({ error: 'Failed to fetch image' });
            }
        }

        // Library mark used
        if (path.indexOf('/api/library/mark-used/') === 0 && req.method === 'POST') {
            var id = path.replace('/api/library/mark-used/', '');
            await sql`UPDATE library SET used = true WHERE org_id = ${orgId} AND (library_id = ${id} OR id = ${id})`;
            return res.status(200).json({ success: true });
        }

        // Library delete
        if (path.indexOf('/api/library/') === 0 && req.method === 'DELETE') {
            var id = path.replace('/api/library/', '');
            await sql`DELETE FROM library WHERE org_id = ${orgId} AND (library_id = ${id} OR id = ${id})`;
            return res.status(200).json({ success: true });
        }

        // Scraper accounts delete
        if (path.indexOf('/api/scraper/accounts/') === 0 && req.method === 'DELETE') {
            var username = path.replace('/api/scraper/accounts/', '');
            await sql`DELETE FROM accounts WHERE org_id = ${orgId} AND username = ${username}`;
            var accs = await sql`SELECT * FROM accounts WHERE org_id = ${orgId} ORDER BY added_at`;
            var cfg = await sql`SELECT * FROM scraper_config WHERE org_id = ${orgId}`;
            return res.status(200).json({
                success: true,
                config: {
                    accounts: accs.rows.map(dbRowToAccount),
                    enabled: cfg.rows[0]?.enabled || false,
                    intervalHours: cfg.rows[0]?.interval_hours || 1,
                    lastRun: cfg.rows[0]?.last_run || null
                }
            });
        }

        return res.status(404).json({ error: 'Not found', path });

    } catch (error) {
        console.error('API Error:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
};

// DB row mappers
function dbRowToLibItem(row) {
    return {
        libraryId: row.library_id,
        id: row.id,
        orgId: row.org_id,
        displayUrl: row.display_url,
        thumbnailUrl: row.thumbnail_url,
        caption: row.caption,
        likes: row.likes,
        comments: row.comments,
        isVideo: row.is_video,
        sourceAccount: row.source_account,
        importedAt: row.imported_at,
        used: row.used
    };
}

function dbRowToAccount(row) {
    return {
        username: row.username,
        fullName: row.full_name,
        profilePic: row.profile_pic,
        followers: row.followers,
        addedAt: row.added_at
    };
}

// Add posts to Postgres library
async function addPostsToDb(orgId, user, username) {
    var posts = (user.edge_owner_to_timeline_media && user.edge_owner_to_timeline_media.edges) || [];
    var newCount = 0;

    for (var i = 0; i < posts.length; i++) {
        var node = posts[i].node;
        var libraryId = 'lib_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        try {
            var result = await sql`
                INSERT INTO library (library_id, id, org_id, display_url, thumbnail_url, caption, likes, comments, is_video, source_account)
                VALUES (
                    ${libraryId}, ${node.id}, ${orgId},
                    ${node.display_url}, ${node.thumbnail_src || node.display_url},
                    ${getCaption(node)}, ${getLikes(node)},
                    ${(node.edge_media_to_comment && node.edge_media_to_comment.count) || 0},
                    ${node.is_video || false}, ${username}
                )
                ON CONFLICT DO NOTHING
            `;
            if (result.rowCount > 0) newCount++;
        } catch (e) {}
    }
    return newCount;
}

async function fetchInstagramProfile(username) {
    var methods = [fetchViaWebProfileInfo, fetchViaGraphQL];
    for (var i = 0; i < methods.length; i++) {
        try {
            var result = await methods[i](username);
            if (result.success) return result;
        } catch (e) {}
    }
    return { success: false, error: 'Could not fetch Instagram data.' };
}

async function fetchViaWebProfileInfo(username) {
    var response = await fetch(
        'https://i.instagram.com/api/v1/users/web_profile_info/?username=' + encodeURIComponent(username),
        { headers: { 'User-Agent': 'Instagram 275.0.0.27.98 Android (33/13; 420dpi; 1080x2400; samsung; SM-G991B; o1s; exynos2100; en_US; 458229237)', 'X-IG-App-ID': '936619743392459', 'X-IG-WWW-Claim': '0', 'X-Requested-With': 'XMLHttpRequest', 'Accept': 'application/json' } }
    );
    var text = await response.text();
    if (!text.startsWith('{')) return { success: false, error: 'Non-JSON response' };
    var data = JSON.parse(text);
    var user = data && data.data && data.data.user;
    if (!user) return { success: false, error: 'User not found' };
    return { success: true, user };
}

async function fetchViaGraphQL(username) {
    var response = await fetch(
        'https://www.instagram.com/api/v1/users/web_profile_info/?username=' + encodeURIComponent(username),
        { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'X-IG-App-ID': '936619743392459', 'X-Requested-With': 'XMLHttpRequest', 'Accept': 'application/json' } }
    );
    var text = await response.text();
    if (!text.startsWith('{')) return { success: false, error: 'Non-JSON response' };
    var data = JSON.parse(text);
    var user = data && data.data && data.data.user;
    if (!user) return { success: false, error: 'User not found' };
    return { success: true, user };
}

function getCaption(node) {
    return node.edge_media_to_caption?.edges?.[0]?.node?.text || '';
}

function getLikes(node) {
    return node.edge_liked_by?.count || node.edge_media_preview_like?.count || 0;
}
