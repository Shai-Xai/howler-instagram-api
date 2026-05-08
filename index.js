// Howler Instagram API v7 - Clerk auth + Neon Postgres

const { verifyToken } = require('@clerk/backend');
const { neon } = require('@neondatabase/serverless');

function getSQL() {
    const url = process.env.HowlerCMS1_POSTGRES_URL
        || process.env.HowlerCMS1_DATABASE_URL
        || process.env.POSTGRES_URL
        || process.env.DATABASE_URL;
    if (!url) throw new Error('No database connection string found in environment variables');
    return neon(url);
}

const sql = (...args) => getSQL()(...args);

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
            media_type TEXT DEFAULT 'post',
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
    await sql`
        CREATE TABLE IF NOT EXISTS posts (
            id TEXT PRIMARY KEY,
            org_id TEXT NOT NULL,
            title TEXT,
            caption TEXT,
            image_url TEXT,
            status TEXT DEFAULT 'draft',
            scheduled_date TEXT,
            community TEXT,
            cta JSONB,
            likes INTEGER DEFAULT 0,
            comments INTEGER DEFAULT 0,
            created_at TIMESTAMPTZ DEFAULT NOW()
        )
    `;
    // Add media_type column if missing (migration for existing tables)
    await sql`ALTER TABLE library ADD COLUMN IF NOT EXISTS media_type TEXT DEFAULT 'post'`;
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

            var profile = igResult.profile;
            if (profile.isPrivate) return res.status(400).json({ success: false, error: 'Private account' });

            await sql`
                INSERT INTO accounts (org_id, username, full_name, profile_pic, followers)
                VALUES (${orgId}, ${profile.username}, ${profile.fullName || ''}, ${profile.profilePic || ''}, ${profile.followers || 0})
            `;

            var newCount = await addPostsToDb(orgId, igResult.posts, profile.username, igResult.reels, igResult.stories);
            var accs = await sql`SELECT * FROM accounts WHERE org_id = ${orgId} ORDER BY added_at`;
            var cfg = await sql`SELECT * FROM scraper_config WHERE org_id = ${orgId}`;

            return res.status(200).json({
                success: true,
                message: 'Added @' + profile.username + ' (' + newCount + ' posts)',
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
                    if (igResult.success && igResult.profile && !igResult.profile.isPrivate) {
                        var newCount = await addPostsToDb(orgId, igResult.posts, acc.username, igResult.reels, igResult.stories);
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

            return res.status(200).json({
                success: true,
                profile: igResult.profile,
                posts: igResult.posts
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

        // CMS Posts - GET
        if (path === '/api/cms/posts' && req.method === 'GET') {
            var rows = await sql`SELECT * FROM posts WHERE org_id = ${orgId} ORDER BY created_at DESC`;
            return res.status(200).json({ success: true, posts: rows.rows.map(dbRowToPost) });
        }

        // CMS Posts - POST (create)
        if (path === '/api/cms/posts' && req.method === 'POST') {
            var b = req.body || {};
            var id = 'post_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
            await sql`
                INSERT INTO posts (id, org_id, title, caption, image_url, status, scheduled_date, community, cta)
                VALUES (${id}, ${orgId}, ${b.title || ''}, ${b.caption || ''}, ${b.imageUrl || ''},
                        ${b.status || 'draft'}, ${b.scheduledDate || null}, ${b.community || null},
                        ${b.cta ? JSON.stringify(b.cta) : null})
            `;
            var row = await sql`SELECT * FROM posts WHERE id = ${id}`;
            return res.status(200).json({ success: true, post: dbRowToPost(row.rows[0]) });
        }

        // CMS Posts - DELETE
        if (path.indexOf('/api/cms/posts/') === 0 && req.method === 'DELETE') {
            var id = path.replace('/api/cms/posts/', '');
            await sql`DELETE FROM posts WHERE org_id = ${orgId} AND id = ${id}`;
            return res.status(200).json({ success: true });
        }

        return res.status(404).json({ error: 'Not found', path });

    } catch (error) {
        console.error('API Error:', error);
        return res.status(500).json({ success: false, error: error.message, detail: error.detail || error.code || '' });
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
        mediaType: row.media_type || 'post',
        sourceAccount: row.source_account,
        importedAt: row.imported_at,
        used: row.used
    };
}

function dbRowToPost(row) {
    return {
        id: row.id,
        title: row.title,
        caption: row.caption,
        image: row.image_url,
        status: row.status,
        date: row.scheduled_date || new Date(row.created_at).toLocaleDateString(),
        community: row.community,
        cta: row.cta,
        likes: row.likes,
        comments: row.comments
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

// Add posts/reels/stories to Postgres library
async function addPostsToDb(orgId, posts, username, reels, stories) {
    var all = [].concat(posts || [], reels || [], stories || []);
    var newCount = 0;

    for (var i = 0; i < all.length; i++) {
        var p = all[i];
        if (!p.id) continue;
        var libraryId = 'lib_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        try {
            var result = await sql`
                INSERT INTO library (library_id, id, org_id, display_url, thumbnail_url, caption, likes, comments, is_video, media_type, source_account)
                VALUES (
                    ${libraryId}, ${p.id}, ${orgId},
                    ${p.displayUrl || ''}, ${p.thumbnailUrl || p.displayUrl || ''},
                    ${p.caption || ''}, ${p.likes || 0},
                    ${p.comments || 0},
                    ${p.isVideo || false}, ${p.mediaType || 'post'}, ${username}
                )
                ON CONFLICT DO NOTHING
            `;
            if (result.rowCount > 0) newCount++;
        } catch (e) {}
    }
    return newCount;
}

const RAPID_HOST = 'instagram-scraper-stable-api.p.rapidapi.com';
const RAPID_BASE = 'https://' + RAPID_HOST;

function rapidHeaders() {
    return { 'x-rapidapi-key': process.env.RAPIDAPI_KEY, 'x-rapidapi-host': RAPID_HOST };
}

function formBody(params) {
    return Object.entries(params).map(function(e) {
        return encodeURIComponent(e[0]) + '=' + encodeURIComponent(e[1]);
    }).join('&');
}

async function fetchInstagramProfile(username) {
    var apiKey = process.env.RAPIDAPI_KEY;
    if (!apiKey) return { success: false, error: 'RAPIDAPI_KEY not configured' };

    var igUrl = username.startsWith('http') ? username : 'https://www.instagram.com/' + username + '/';

    try {
        var profileRes = await fetch(
            RAPID_BASE + '/ig_get_fb_profile_hover.php?username_or_url=' + encodeURIComponent(igUrl),
            { headers: rapidHeaders() }
        );

        if (!profileRes.ok) return { success: false, error: 'Could not fetch Instagram profile (status ' + profileRes.status + ')' };

        var profileData = await profileRes.json();
        var u = profileData.user_data || profileData.data?.user || profileData.user || null;
        if (!u) return { success: false, error: 'User not found' };

        var profile = {
            username: u.username || username,
            fullName: u.full_name || '',
            bio: u.biography || u.bio || '',
            profilePic: u.profile_pic_url_hd || u.profile_pic_url || '',
            followers: u.edge_followed_by?.count || u.follower_count || 0,
            following: u.edge_follow?.count || u.following_count || 0,
            postsCount: u.edge_owner_to_timeline_media?.count || u.media_count || 0,
            isPrivate: !!u.is_private,
            isVerified: !!u.is_verified
        };

        // Fetch posts, reels, stories in parallel
        var [postsRes, reelsRes, storiesRes] = await Promise.allSettled([
            fetch(RAPID_BASE + '/get_ig_user_posts.php', {
                method: 'POST',
                headers: { ...rapidHeaders(), 'Content-Type': 'application/x-www-form-urlencoded' },
                body: formBody({ username_or_url: igUrl, amount: 12 })
            }),
            fetch(RAPID_BASE + '/get_ig_user_reels.php', {
                method: 'POST',
                headers: { ...rapidHeaders(), 'Content-Type': 'application/x-www-form-urlencoded' },
                body: formBody({ username_or_url: igUrl, amount: 12 })
            }),
            fetch(RAPID_BASE + '/get_ig_user_stories.php', {
                method: 'POST',
                headers: { ...rapidHeaders(), 'Content-Type': 'application/x-www-form-urlencoded' },
                body: formBody({ username_or_url: igUrl, amount: 12 })
            })
        ]);

        var posts = [];
        if (postsRes.status === 'fulfilled' && postsRes.value.ok) {
            var d = await postsRes.value.json();
            posts = (d.posts || d.data || d.items || []).map(function(p) { return mapMediaItem(p, 'post'); });
        }

        var reels = [];
        if (reelsRes.status === 'fulfilled' && reelsRes.value.ok) {
            var d = await reelsRes.value.json();
            reels = (d.reels || d.data || d.items || []).map(function(r) { return mapMediaItem(r?.node?.media || r?.node || r, 'reel'); });
        }

        var stories = [];
        if (storiesRes.status === 'fulfilled' && storiesRes.value.ok) {
            var d = await storiesRes.value.json();
            var raw = Array.isArray(d) ? d : (d.data || d.items || []);
            stories = raw.slice(0, 12).map(function(s) { return mapMediaItem(s, 'story'); });
        }

        return { success: true, profile: profile, posts: posts, reels: reels, stories: stories };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

function mapMediaItem(n, mediaType) {
    var node = n.node || n;
    var thumb = node.display_url || node.thumbnail_src || node.image_versions2?.candidates?.[0]?.url || node.thumbnail_url || '';
    var isVideo = !!(node.is_video || node.media_type === 2 || node.video_url || node.video_versions?.length);
    return {
        id: node.id || node.pk || '',
        displayUrl: thumb,
        thumbnailUrl: thumb,
        caption: node.edge_media_to_caption?.edges?.[0]?.node?.text || node.caption?.text || '',
        likes: node.edge_liked_by?.count || node.like_count || 0,
        comments: node.edge_media_to_comment?.count || node.comment_count || 0,
        isVideo: isVideo,
        mediaType: mediaType || (isVideo ? 'video' : 'image')
    };
}

function getCaption(node) {
    return node.edge_media_to_caption?.edges?.[0]?.node?.text || '';
}

function getLikes(node) {
    return node.edge_liked_by?.count || node.edge_media_preview_like?.count || 0;
}
