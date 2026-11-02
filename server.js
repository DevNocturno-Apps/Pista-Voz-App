'use strict';

require('dotenv').config();

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const helmet = require('helmet');
const multer = require('multer');
const { rateLimit } = require('express-rate-limit');

const app = express();
const port = Number(process.env.PORT || 3000);
const production = process.env.NODE_ENV === 'production';
const appBaseUrl = new URL(process.env.APP_BASE_URL || `http://localhost:${port}`);
const dataDirectory = path.join(__dirname, 'data');
const uploadDirectory = path.join(dataDirectory, 'uploads');
const sessionSecret = process.env.SESSION_SECRET;
const configuredEncryptionKey = process.env.TOKEN_ENCRYPTION_KEY || '';
const graphVersion = process.env.INSTAGRAM_GRAPH_VERSION || 'v24.0';
const instagramEnabled = Boolean(process.env.INSTAGRAM_APP_ID && process.env.INSTAGRAM_APP_SECRET);
const googleEnabled = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_API_KEY);
const instagramScopes = ['instagram_business_basic', 'instagram_business_content_publish'];
const mediaMaxAgeMs = 60 * 60 * 1000;

fs.mkdirSync(dataDirectory, { recursive: true });
fs.mkdirSync(uploadDirectory, { recursive: true });

if (production && appBaseUrl.protocol !== 'https:') {
    throw new Error('APP_BASE_URL must use HTTPS in production.');
}
if (production && (!sessionSecret || sessionSecret.length < 32)) {
    throw new Error('Set SESSION_SECRET to a random value at least 32 characters long.');
}
if (production && !/^[a-f0-9]{64}$/i.test(configuredEncryptionKey)) {
    throw new Error('Set TOKEN_ENCRYPTION_KEY to 64 hexadecimal characters in production.');
}

const encryptionKey = /^[a-f0-9]{64}$/i.test(configuredEncryptionKey)
    ? Buffer.from(configuredEncryptionKey, 'hex')
    : crypto.randomBytes(32);
if (!production && (!sessionSecret || !configuredEncryptionKey)) {
    console.warn('Using temporary development secrets. Add secrets to .env before production; connected accounts will reset on restart.');
}

app.set('trust proxy', production ? 1 : false);
app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' }
}));
app.use(express.json({ limit: '1mb' }));
app.use(session({
    name: 'pista-voz.sid',
    secret: sessionSecret || crypto.randomBytes(48).toString('hex'),
    resave: false,
    saveUninitialized: false,
    store: new FileStore({
        path: path.join(dataDirectory, 'sessions'),
        fileMode: 0o600,
        dirMode: 0o700,
        reapInterval: 60 * 60
    }),
    cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: production,
        maxAge: 24 * 60 * 60 * 1000
    }
}));

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: 'draft-7',
    legacyHeaders: false
});
const publishLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 5,
    standardHeaders: 'draft-7',
    legacyHeaders: false
});

const requireSameOrigin = (request, response, next) => {
    const origin = request.get('origin');
    if (!origin || new URL(origin).origin !== appBaseUrl.origin) {
        response.status(403).json({ error: 'Request origin is not allowed.' });
        return;
    }
    next();
};

const videoUpload = multer({
    dest: uploadDirectory,
    limits: { fileSize: 150 * 1024 * 1024, files: 1 },
    fileFilter(request, file, callback) {
        if (file.mimetype !== 'video/mp4') {
            callback(new Error('Choose an MP4 video. This browser exported a format Instagram cannot publish directly.'));
            return;
        }
        callback(null, true);
    }
});

function encryptToken(token) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
    const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString('base64url')).join('.');
}

function decryptToken(value) {
    const [iv, tag, encrypted] = value.split('.').map((part) => Buffer.from(part, 'base64url'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

async function readApiResponse(response, service) {
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.error) {
        const error = new Error(payload?.error?.message || payload?.error_description || `${service} failed (HTTP ${response.status}).`);
        error.status = response.status >= 400 && response.status < 500 ? 400 : 502;
        throw error;
    }
    return payload;
}

function redirectToApp(response, parameter, value) {
    const destination = new URL('/', appBaseUrl);
    destination.searchParams.set(parameter, value);
    response.redirect(destination.href);
}

function graphUrl(pathname) {
    return `https://graph.instagram.com/${graphVersion}/${pathname}`;
}

async function getInstagramToken(request) {
    const account = request.session.instagram;
    if (!account?.encryptedToken || !account.userId) {
        const error = new Error('Connect your Instagram professional account first.');
        error.status = 401;
        throw error;
    }

    if (account.expiresAt - Date.now() > 7 * 24 * 60 * 60 * 1000) {
        return { token: decryptToken(account.encryptedToken), account };
    }

    const refreshUrl = new URL('https://graph.instagram.com/refresh_access_token');
    refreshUrl.searchParams.set('grant_type', 'ig_refresh_token');
    refreshUrl.searchParams.set('access_token', decryptToken(account.encryptedToken));
    const response = await fetch(refreshUrl, { signal: AbortSignal.timeout(20000) });
    const refreshed = await readApiResponse(response, 'Instagram token refresh');
    if (!refreshed.access_token) throw new Error('Instagram did not return a refreshed token.');
    account.encryptedToken = encryptToken(refreshed.access_token);
    account.expiresAt = Date.now() + Number(refreshed.expires_in || 0) * 1000;
    await new Promise((resolve, reject) => request.session.save((error) => error ? reject(error) : resolve()));
    return { token: refreshed.access_token, account };
}

async function postGraphForm(url, parameters) {
    const response = await fetch(url, {
        method: 'POST',
        body: new URLSearchParams(parameters),
        signal: AbortSignal.timeout(30000)
    });
    return readApiResponse(response, 'Instagram publishing');
}

app.get('/api/config', (request, response) => {
    response.set('Cache-Control', 'no-store');
    response.json({
        googleClientId: process.env.GOOGLE_CLIENT_ID || '',
        googleApiKey: process.env.GOOGLE_API_KEY || '',
        googlePhotosEnabled: googleEnabled,
        instagramEnabled
    });
});

app.get('/api/instagram/status', (request, response) => {
    const account = request.session.instagram;
    response.set('Cache-Control', 'no-store');
    response.json({
        configured: instagramEnabled,
        connected: Boolean(account?.encryptedToken && account.userId),
        username: account?.username || ''
    });
});

app.get('/api/instagram/auth/start', authLimiter, (request, response) => {
    if (!instagramEnabled) {
        redirectToApp(response, 'instagram_error', 'not_configured');
        return;
    }

    const state = crypto.randomBytes(32).toString('base64url');
    request.session.instagramOAuthState = state;
    request.session.save((error) => {
        if (error) {
            console.error('Could not save OAuth state:', error);
            redirectToApp(response, 'instagram_error', 'session');
            return;
        }
        const authorizationUrl = new URL('https://www.instagram.com/oauth/authorize');
        authorizationUrl.searchParams.set('client_id', process.env.INSTAGRAM_APP_ID);
        authorizationUrl.searchParams.set('redirect_uri', new URL('/api/instagram/callback', appBaseUrl).href);
        authorizationUrl.searchParams.set('response_type', 'code');
        authorizationUrl.searchParams.set('scope', instagramScopes.join(','));
        authorizationUrl.searchParams.set('state', state);
        response.redirect(authorizationUrl.href);
    });
});

app.get('/api/instagram/callback', authLimiter, async (request, response) => {
    const expectedState = request.session.instagramOAuthState;
    delete request.session.instagramOAuthState;
    if (request.query.error) {
        redirectToApp(response, 'instagram_error', 'denied');
        return;
    }
    const actualState = typeof request.query.state === 'string' ? request.query.state : '';
    const actualStateBuffer = Buffer.from(actualState);
    const expectedStateBuffer = Buffer.from(expectedState || '');
    if (!expectedState || actualStateBuffer.length !== expectedStateBuffer.length ||
        !crypto.timingSafeEqual(actualStateBuffer, expectedStateBuffer)) {
        redirectToApp(response, 'instagram_error', 'state');
        return;
    }
    if (!instagramEnabled || typeof request.query.code !== 'string') {
        redirectToApp(response, 'instagram_error', 'configuration');
        return;
    }

    try {
        const shortResponse = await fetch('https://api.instagram.com/oauth/access_token', {
            method: 'POST',
            body: new URLSearchParams({
                client_id: process.env.INSTAGRAM_APP_ID,
                client_secret: process.env.INSTAGRAM_APP_SECRET,
                grant_type: 'authorization_code',
                redirect_uri: new URL('/api/instagram/callback', appBaseUrl).href,
                code: request.query.code
            }),
            signal: AbortSignal.timeout(20000)
        });
        const shortTokenPayload = await readApiResponse(shortResponse, 'Instagram authorization');
        const shortToken = Array.isArray(shortTokenPayload.data) ? shortTokenPayload.data[0] : shortTokenPayload;
        if (!shortToken.access_token) throw new Error('Instagram did not return an access token.');

        const exchangeUrl = new URL('https://graph.instagram.com/access_token');
        exchangeUrl.searchParams.set('grant_type', 'ig_exchange_token');
        exchangeUrl.searchParams.set('client_secret', process.env.INSTAGRAM_APP_SECRET);
        exchangeUrl.searchParams.set('access_token', shortToken.access_token);
        const longResponse = await fetch(exchangeUrl, { signal: AbortSignal.timeout(20000) });
        const longToken = await readApiResponse(longResponse, 'Instagram token exchange');
        if (!longToken.access_token) throw new Error('Instagram did not return a long-lived token.');

        const profileUrl = new URL('https://graph.instagram.com/me');
        profileUrl.searchParams.set('fields', 'user_id,username');
        profileUrl.searchParams.set('access_token', longToken.access_token);
        const profileResponse = await fetch(profileUrl, { signal: AbortSignal.timeout(20000) });
        const profile = await readApiResponse(profileResponse, 'Instagram account lookup');
        if (!profile.user_id) throw new Error('Instagram did not return a professional account ID.');

        await new Promise((resolve, reject) => {
            request.session.regenerate((error) => error ? reject(error) : resolve());
        });
        request.session.instagram = {
            encryptedToken: encryptToken(longToken.access_token),
            userId: String(profile.user_id),
            username: profile.username || '',
            expiresAt: Date.now() + Number(longToken.expires_in || 0) * 1000
        };
        request.session.save((error) => {
            if (error) {
                console.error('Could not save Instagram credentials:', error);
                redirectToApp(response, 'instagram_error', 'session');
                return;
            }
            redirectToApp(response, 'instagram', 'connected');
        });
    } catch (error) {
        console.error('Instagram OAuth failed:', error);
        redirectToApp(response, 'instagram_error', 'authorization');
    }
});

app.post('/api/instagram/disconnect', requireSameOrigin, (request, response, next) => {
    delete request.session.instagram;
    request.session.save((error) => error ? next(error) : response.json({ connected: false }));
});

app.post('/api/instagram/publish', requireSameOrigin, publishLimiter, (request, response, next) => {
    if (!instagramEnabled) {
        response.status(503).json({ error: 'Instagram publishing is not configured on this server.' });
        return;
    }
    if (!request.session.instagram?.encryptedToken) {
        response.status(401).json({ error: 'Connect an Instagram professional account first.' });
        return;
    }
    videoUpload.single('video')(request, response, (error) => {
        if (error) {
            response.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400)
                .json({ error: error.message || 'Video upload failed.' });
            return;
        }
        publishInstagramVideo(request, response).catch(next);
    });
});

async function publishInstagramVideo(request, response) {
    const file = request.file;
    if (!file) {
        response.status(400).json({ error: 'Choose an MP4 video to publish.' });
        return;
    }

    let publicFile;
    try {
        const header = Buffer.alloc(12);
        const handle = await fs.promises.open(file.path, 'r');
        try {
            await handle.read(header, 0, header.length, 0);
        } finally {
            await handle.close();
        }
        if (header.toString('ascii', 4, 8) !== 'ftyp') {
            response.status(400).json({ error: 'The uploaded file is not a valid MP4.' });
            return;
        }

        const format = request.body.format;
        if (!['Post', 'Reel', 'Story'].includes(format)) {
            response.status(400).json({ error: 'Choose Post, Reel, or Story.' });
            return;
        }
        if (!instagramEnabled) {
            response.status(503).json({ error: 'Instagram publishing is not configured on this server.' });
            return;
        }

        const { token, account } = await getInstagramToken(request);
        const filename = `${crypto.randomUUID()}.mp4`;
        publicFile = path.join(uploadDirectory, filename);
        await fs.promises.rename(file.path, publicFile);
        const videoUrl = new URL(`/instagram-media/${filename}`, appBaseUrl).href;
        const mediaType = format === 'Story' ? 'STORIES' : format === 'Reel' ? 'REELS' : 'VIDEO';
        const parameters = {
            media_type: mediaType,
            video_url: videoUrl,
            access_token: token
        };
        if (format === 'Reel') parameters.share_to_feed = 'true';
        if (format !== 'Story' && typeof request.body.caption === 'string') {
            parameters.caption = request.body.caption.slice(0, 2200);
        }

        const container = await postGraphForm(
            graphUrl(`${encodeURIComponent(account.userId)}/media`),
            parameters
        );
        if (!container.id) throw new Error('Instagram did not create a publishing container.');

        const deadline = Date.now() + 2 * 60 * 1000;
        let containerStatus;
        do {
            await new Promise((resolve) => setTimeout(resolve, 3000));
            const statusUrl = new URL(graphUrl(encodeURIComponent(container.id)));
            statusUrl.searchParams.set('fields', 'status_code,status');
            statusUrl.searchParams.set('access_token', token);
            const statusResponse = await fetch(statusUrl, { signal: AbortSignal.timeout(20000) });
            containerStatus = await readApiResponse(statusResponse, 'Instagram video processing');
            if (containerStatus.status_code === 'ERROR' || containerStatus.status_code === 'EXPIRED') {
                throw new Error(containerStatus.status || 'Instagram could not process the video.');
            }
        } while (containerStatus.status_code !== 'FINISHED' && Date.now() < deadline);
        if (containerStatus.status_code !== 'FINISHED') {
            throw new Error('Instagram is still processing the video. Try publishing again shortly.');
        }

        const published = await postGraphForm(
            graphUrl(`${encodeURIComponent(account.userId)}/media_publish`),
            { creation_id: container.id, access_token: token }
        );
        response.json({ published: true, id: published.id, username: account.username, format });
    } finally {
        await fs.promises.unlink(file.path).catch((error) => {
            if (error.code !== 'ENOENT') console.error('Could not remove temporary video:', error);
        });
        if (publicFile) {
            setTimeout(() => {
                fs.promises.unlink(publicFile).catch((error) => {
                    if (error.code !== 'ENOENT') console.error('Could not remove published media:', error);
                });
            }, mediaMaxAgeMs).unref();
        }
    }
}

app.get('/instagram-media/:filename', async (request, response, next) => {
    const { filename } = request.params;
    if (!/^[a-f0-9-]{36}\.mp4$/i.test(filename)) {
        response.sendStatus(404);
        return;
    }
    const filenamePath = path.join(uploadDirectory, filename);
    try {
        const details = await fs.promises.stat(filenamePath);
        if (Date.now() - details.mtimeMs > mediaMaxAgeMs) {
            await fs.promises.unlink(filenamePath);
            response.sendStatus(404);
            return;
        }
        response.set({
            'Content-Type': 'video/mp4',
            'Cache-Control': 'no-store',
            'Access-Control-Allow-Origin': '*'
        });
        response.sendFile(filenamePath);
    } catch (error) {
        if (error.code === 'ENOENT') response.sendStatus(404);
        else next(error);
    }
});

setInterval(() => {
    const now = Date.now();
    fs.promises.readdir(uploadDirectory).then((filenames) => Promise.all(
        filenames.filter((filename) => /^[a-f0-9-]{36}\.mp4$/i.test(filename)).map(async (filename) => {
            const filePath = path.join(uploadDirectory, filename);
            try {
                const details = await fs.promises.stat(filePath);
                if (now - details.mtimeMs > mediaMaxAgeMs) await fs.promises.unlink(filePath);
            } catch (error) {
                if (error.code !== 'ENOENT') console.error('Could not clean media file:', error);
            }
        })
    )).catch((error) => console.error('Could not scan uploaded media:', error));
}, 10 * 60 * 1000).unref();

app.get(['/', '/index.html'], (request, response) => {
    response.set('Cache-Control', 'no-cache');
    response.sendFile(path.join(__dirname, 'index.html'));
});
app.get('/logo.jpg', (request, response) => {
    response.sendFile(path.join(__dirname, 'logo.jpg'));
});
app.get('/manifest.webmanifest', (request, response) => {
    response.set('Cache-Control', 'no-cache');
    response.sendFile(path.join(__dirname, 'manifest.webmanifest'));
});
app.get('/app-icon.svg', (request, response) => {
    response.sendFile(path.join(__dirname, 'app-icon.svg'));
});
app.get('/sw.js', (request, response) => {
    response.set('Cache-Control', 'no-cache');
    response.sendFile(path.join(__dirname, 'sw.js'));
});

app.use((error, request, response, next) => {
    console.error('Request failed:', error);
    if (response.headersSent) {
        next(error);
        return;
    }
    response.status(error.status || 500).json({
        error: production && error.status !== 400 ? 'The request could not be completed.' : error.message
    });
});

app.listen(port, () => {
    console.log(`Pista & Voz listening at ${appBaseUrl.origin}`);
    if (!googleEnabled) console.warn('Google Photos Picker is disabled until GOOGLE_CLIENT_ID and GOOGLE_API_KEY are configured.');
    if (!instagramEnabled) console.warn('Instagram publishing is disabled until INSTAGRAM_APP_ID and INSTAGRAM_APP_SECRET are configured.');
});
