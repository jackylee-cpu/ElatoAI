/** @type {import('next').NextConfig} */

// Character artwork is served from the Supabase storage bucket, whose host
// changes per deployment (the production one self-hosts Supabase). next/image
// refuses a remote src that is not listed here, so derive it from the same
// public URL the client uses; NEXT_PUBLIC_SUPABASE_URL is a build arg in the
// Dockerfile, so it is set when this file is read.
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;

const remotePatterns = [];
if (supabaseUrl) {
    try {
        // Keep the URL's own path: production serves Supabase under a prefix
        // (https://<host>/supabase-api), and a pattern without it rejects every
        // uploaded picture with a 400 while working fine locally.
        const { protocol, hostname, port, pathname } = new URL(supabaseUrl);
        remotePatterns.push({
            protocol: protocol.replace(":", ""),
            hostname,
            port: port || "",
            pathname: `${pathname.replace(/\/+$/, "")}/storage/v1/object/public/**`,
        });
    } catch {
        console.warn("NEXT_PUBLIC_SUPABASE_URL is not a valid URL, remote images disabled");
    }
}

const nextConfig = {
    output: "standalone",
    images: { remotePatterns },
};

module.exports = nextConfig;
