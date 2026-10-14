import React from "react";
import { Panel } from "./PreviewKit";
import type { AdminPageId } from "../adminPages";

const PLANS: Partial<Record<AdminPageId, string[]>> = {
    safety: [
        "Inputs and replies blocked each day, by category only (violence, sexual, personal data, self-harm…), never the text itself (Q7)",
        "Block rate by character and by toy, with an alert when one toy suddenly rises",
        "Switches and thresholds for the moderation rules",
    ],
    health: [
        "Voice server: live sessions, CPU and memory",
        "Error rate and latency per provider over the last hour (OpenRouter, Azure, MiniMax)",
        "Where alerts go: WhatsApp, email",
        "When the database was last backed up, and the last restore drill (P2-07)",
    ],
};

const PlannedPage: React.FC<{ id: AdminPageId }> = ({ id }) => (
    <Panel title="Planned for before production">
        <ul className="list-disc space-y-1.5 pl-5 text-sm text-gray-700">
            {(PLANS[id] ?? []).map((item) => (
                <li key={item}>{item}</li>
            ))}
        </ul>
    </Panel>
);

export default PlannedPage;
