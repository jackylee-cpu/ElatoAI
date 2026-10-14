// The admin console's pages, in sidebar order.
//
// "live" pages are the working tabs. "preview" pages show the planned screen
// with example data and nothing wired up; "planned" pages only describe what
// will go there. Both of those are for super admins only, so a content admin
// still sees exactly the two pages they can use.

export type AdminPageId =
    | "overview"
    | "devices"
    | "support"
    | "characters"
    | "ips"
    | "ota"
    | "factory"
    | "latency"
    | "usage"
    | "safety"
    | "health"
    | "model"
    | "accounts"
    | "admins"
    | "audit";

export type AdminPageKind = "live" | "preview" | "planned";

export interface AdminPage {
    id: AdminPageId;
    label: string;
    title: string;
    description: string;
    kind: AdminPageKind;
    superOnly: boolean;
}

export interface AdminPageGroup {
    label: string;
    pages: AdminPage[];
}

export const ADMIN_PAGE_GROUPS: AdminPageGroup[] = [
    {
        label: "Operations",
        pages: [
            {
                id: "overview",
                label: "Overview",
                title: "Overview",
                description:
                    "Which toys are online, how much they are used, and what needs attention today.",
                kind: "preview",
                superOnly: true,
            },
            {
                id: "devices",
                label: "Devices",
                title: "Devices",
                description:
                    "Each toy's status, firmware and binding. Conversations and memories are never shown.",
                kind: "live",
                superOnly: true,
            },
            {
                id: "support",
                label: "Support",
                title: "Support",
                description:
                    "For a parent on the phone: one search finds the account, its toys and what happened lately.",
                kind: "preview",
                superOnly: true,
            },
        ],
    },
    {
        label: "Content",
        pages: [
            {
                id: "characters",
                label: "Characters",
                title: "Characters",
                description: "The characters children can talk to, on the web app and on the toys.",
                kind: "live",
                superOnly: false,
            },
            {
                id: "ips",
                label: "IPs",
                title: "IPs",
                description: "Each IP and the modes, styles and characters it allows.",
                kind: "live",
                superOnly: false,
            },
        ],
    },
    {
        label: "Firmware",
        pages: [
            {
                id: "ota",
                label: "OTA releases",
                title: "OTA releases",
                description:
                    "Upload a build and roll it out in stages; too many rollbacks pause it.",
                kind: "preview",
                superOnly: true,
            },
            {
                id: "factory",
                label: "Factory",
                title: "Factory registration",
                description:
                    "Import the board supplier's MAC list; the factory station writes keys, self-tests and reports back.",
                kind: "preview",
                superOnly: true,
            },
        ],
    },
    {
        label: "Monitoring",
        pages: [
            {
                id: "latency",
                label: "Latency",
                title: "Latency",
                description: "How long each stage of a turn takes, from the latest recorded turns.",
                kind: "live",
                superOnly: true,
            },
            {
                id: "usage",
                label: "Usage & cost",
                title: "Usage & cost",
                description:
                    "What each toy costs to run: STT audio, LLM tokens and TTS characters, priced per provider.",
                kind: "live",
                superOnly: true,
            },
            {
                id: "safety",
                label: "Content safety",
                title: "Content safety",
                description: "Arrives with the moderation layer (P1-01).",
                kind: "planned",
                superOnly: true,
            },
            {
                id: "health",
                label: "System health",
                title: "System health",
                description: "Error tracking and alerting (P2-06).",
                kind: "planned",
                superOnly: true,
            },
        ],
    },
    {
        label: "System",
        pages: [
            {
                id: "model",
                label: "Model",
                title: "Model",
                description: "Settings here apply to every session, on the web app and on the toys.",
                kind: "live",
                superOnly: true,
            },
            {
                id: "accounts",
                label: "Accounts",
                title: "Accounts",
                description:
                    "Create, edit and remove login accounts. Search, status and role narrow the list.",
                kind: "live",
                superOnly: true,
            },
            {
                id: "admins",
                label: "Admins",
                title: "Admins",
                description: "Who holds which admin role.",
                kind: "live",
                superOnly: true,
            },
            {
                id: "audit",
                label: "Audit log",
                title: "Audit log",
                description:
                    "Who changed what in this console, and when. Records can only be added: nobody can edit or delete them.",
                kind: "live",
                superOnly: true,
            },
        ],
    },
];

/** The groups and pages this admin may open, empty groups dropped. */
export function pagesFor(isSuper: boolean): AdminPageGroup[] {
    return ADMIN_PAGE_GROUPS.map((group) => ({
        ...group,
        pages: group.pages.filter((page) => isSuper || !page.superOnly),
    })).filter((group) => group.pages.length > 0);
}
