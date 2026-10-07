/** The token in an `Authorization: Bearer <token>` header, or null. */
export const bearerToken = (req: Request): string | null => {
    const header = req.headers.get("authorization") ?? "";
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    return match ? match[1] : null;
};
