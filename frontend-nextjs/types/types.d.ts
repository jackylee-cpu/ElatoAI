// types/type.d.ts

declare global {
    interface IInbound {
        inbound_id?: string;
        name: string;
        email: string;
        type: "demo" | "preorder";
    }

    interface SidebarNavItem {
        title: string;
        href: string;
        icon: React.ReactNode;
        isPrimary?: boolean;
    }

    interface ILanguage {
        language_id: string;
        code: string;
        name: string;
        flag: string;
    }

    // A place the child can live, for the date, time and weather the voice
    // server puts in the system prompt. See supabase/migrations/*_add_regions.sql.
    interface IRegion {
        code: string;
        name: string;
        flag: string;
        timezone: string;
        latitude: number;
        longitude: number;
        sort_order: number;
    }

    // Whose world a character lives in. Every character belongs to one IP,
    // and the child's memories are kept per IP. restrict_modes /
    // restrict_styles limit an IP to its ip_modes / ip_styles rows; off, every
    // mode and style is allowed and ip_modes only adds flavour. See
    // supabase/migrations/*_add_ips_modes_styles.sql.
    interface IIp {
        ip_key: string;
        name: string;
        description: string;
        // Hard limits for every character in the IP; placed after the style
        // and mode in the system prompt.
        guardrails: string;
        restrict_modes: boolean;
        restrict_styles: boolean;
        image_url: string | null;
        is_hidden: boolean;
        sort_order: number;
        // Who a board in this toy is when the account's character belongs to
        // another IP. Null: the IP's first visible character.
        default_personality_id: string | null;
        ip_modes?: { mode_key: string; prompt: string }[];
        ip_styles?: { style_key: string }[];
    }

    // What the character is doing (companion, story, language) and the manner
    // it does it in (playful, gentle, silly). Both are written in the voice
    // server's content/*.yaml and synced into these tables on startup, so the
    // web app only ever reads them.
    interface IMode {
        mode_key: string;
        name: string;
        description: string;
        sort_order: number;
    }

    interface IStyle {
        style_key: string;
        name: string;
        description: string;
        sort_order: number;
    }

    type ProductColor = "black" | "white" | "gray";

    interface IDevice {
        device_id: string;
        is_reset: boolean;
        is_ota: boolean;
        volume: number;
        mac_address: string;
        user_code: string;
        // The toy this board is sewn into; it only runs that IP's characters.
        // Null: not locked. Set by a super admin, never by the owner.
        ip_key: string | null;
    }

    interface IUser {
        user_id: string;
        avatar_url: string;
        is_premium: boolean;
        email: string;
        supervisor_name: string;
        supervisee_name: string;
        supervisee_persona: string;
        supervisee_age: number;
        session_time: number;
        user_info: UserInfo;

        // personality
        personality_id: string;
        personality?: IPersonality;

        // language
        language?: ILanguage;
        language_code: string;

        // region: null until chosen; the voice server then uses its own default.
        region_code?: string | null;

        // Bumped whenever a memory is deleted. The voice server compares it at
        // session start and rebuilds the toy's memory when it has changed, so
        // a deletion takes effect on a live device rather than at some later
        // unspecified point.
        memories_revision?: number;
    }

    type UserInfo =
        | {
            user_type: "user";
            user_metadata: IUserMetadata;
        }
        | {
            user_type: "business";
            user_metadata: IBusinessMetadata;
        };

    interface IBusinessMetadata {}

    interface IUserMetadata {}

    type Role = "user" | "assistant";

    /**
     * One thing the toy remembers, and what it answered at the time.
     *
     * Memory is deliberately not scoped per character: it is the same child
     * whichever character they talk to. `source_personality_key` records where
     * a memory came from, for display only.
     */
    /**
     * One site-wide setting group, keyed by name with a jsonb body.
     *
     * `voice_stack` is the only key so far. A field absent from `value` means
     * "use whatever the voice server was started with", so an untouched
     * install behaves exactly as it did before the admin page existed.
     */
    interface IAppSetting {
        key: string;
        value: IVoiceStackSettings;
        updated_at: string;
        updated_by: string | null;
    }

    interface IVoiceStackSettings {
        llm_model?: string;
        provider_sort?: OpenRouterProviderSort;
        /** OpenRouter provider slugs, tried first and in this order. */
        provider_order?: string[];
        reasoning_effort?: OpenRouterReasoningEffort;
    }

    // Mirrors _VALID_SORTS in server/fastapi/models/llm/openrouter.py.
    type OpenRouterProviderSort = "latency" | "throughput" | "price" | "nitro";

    // Mirrors _VALID_EFFORTS in server/fastapi/models/llm/openrouter.py.
    type OpenRouterReasoningEffort =
        | "none"
        | "minimal"
        | "low"
        | "medium"
        | "high"
        | "xhigh";

    /**
     * What one conversational turn cost, in milliseconds.
     *
     * Written by the voice server's observer, one row per turn. Every duration
     * is nullable on purpose: a turn cut short by barge-in or a dropped socket
     * is still worth keeping, so reading these means tolerating nulls rather
     * than assuming a number is there.
     */
    interface ITurnMetric {
        turn_metric_id: string;
        created_at: string;
        user_id: string | null;
        chat_group_id: string | null;
        turn_index: number;
        transport: string | null;
        personality_key: string | null;
        stt_provider: string | null;
        llm_provider: string | null;
        tts_provider: string | null;
        llm_model: string | null;
        // Every span below is measured between two frames inside the voice
        // server, on the pipeline clock. None of them include the trip to or
        // from the device: the commit arriving over the websocket is the start,
        // and the server handing audio to the transport is the end. The child
        // waits for the network and the toy's own playback buffer on top.
        //
        // commit received -> final transcript
        stt_ms: number | null;
        // Wall clock instant the final transcript was emitted, for lining a
        // turn up against the conversation and the server log.
        stt_done_at: string | null;
        // final transcript -> user turn closed. Dead time waiting on
        // ExternalUserTurnStopStrategy's transcript-merge timer (~80ms after
        // an explicit commit), still counted inside llm_ttfb_ms; subtract it
        // for the model's own latency.
        turn_close_ms: number | null;
        // final transcript -> first LLM token (turn_close_ms included)
        llm_ttfb_ms: number | null;
        // first LLM token -> last LLM token
        llm_total_ms: number | null;
        // first LLM token -> first audio out
        tts_ttfb_ms: number | null;
        // commit received -> first audio handed to the transport
        total_ms: number | null;
        prompt_tokens: number | null;
        completion_tokens: number | null;
        transcript_chars: number | null;
        response_chars: number | null;
        interrupted: boolean;
        detail: ITurnMetricDetail;
        // What the vendors bill on (P2-09). Null on rows written before them.
        stt_audio_ms: number | null;
        tts_chars: number | null;
        // The board, from its verified token; null for the web playground.
        device_id: string | null;
        // 'turn' is a conversational turn. 'usage' and 'memory' only carry
        // billing: usage with no turn to ride on, and memory consolidation.
        row_kind: "turn" | "usage" | "memory";
    }

    // The services' own reported figures, kept next to ours. When they
    // disagree, the gap is time spent in the pipeline rather than waiting on an
    // API -- which is the distinction you need before blaming a model.
    interface ITurnMetricDetail {
        ttfb?: { processor: string; model: string | null; secs: number }[];
        ttfa?: {
            processor: string;
            model: string | null;
            secs: number;
            leading_silence_secs: number;
        }[];
        processing?: { processor: string; model: string | null; secs: number }[];
        /**
         * What stt_ms and total_ms are measured from. "commit" is the client's
         * own end_of_speech -- the button coming up, which is the only anchor
         * that means what the column header says. "stopped" is the frame the
         * server derives from it a few hops later, "vad" is the recognizer's
         * silence detector standing in for a client that never said it was
         * done, and null is a turn with no start mark at all.
         */
        stt_anchor?: "commit" | "stopped" | "vad" | null;
        /** Was the child ever heard to start speaking in this turn. */
        speech_started?: boolean;
        /** A release arrived for a turn that had already been transcribed. */
        late_release?: boolean;
    }

    /** One model as OpenRouter's /api/v1/models lists it. */
    interface IOpenRouterModel {
        id: string;
        name: string;
        context_length: number | null;
        prompt_price: number | null;
        completion_price: number | null;
    }

    /** One host that serves a model, from OpenRouter's endpoints list. */
    interface IOpenRouterEndpoint {
        slug: string;
        name: string;
        quantization: string | null;
        uptime: number | null;
    }

    /**
     * One thing the toy knows about the child, learned from a conversation.
     *
     * Only active facts are ever listed: one that was replaced by a newer
     * version keeps its row for tracing, with `superseded_at` set.
     */
    interface IMemoryFact {
        fact_id: string;
        content: string;
        chat_group_id: string | null;
        created_at: string;
    }

    /**
     * One stretch of a conversation, compressed to a sentence or two.
     *
     * Written by the voice server, never edited by hand. The latest couple
     * from conversations with substance are what the toy reads at the start
     * of the next one.
     */
    interface IMemorySegment {
        segment_id: string;
        summary: string;
        from_turn: number;
        to_turn: number;
        chat_group_id: string | null;
        created_at: string;
    }

    interface IConversation {
        conversation_id?: string;
        created_at?: string;
        personality_key: string;
        user_id: string;
        role: Role;
        content: string;
        metadata: any;
        chat_group_id: string | null;
        is_sensitive: boolean;
    }

    type VoiceType =
        | {
            provider: "openai";
            id: OaiVoice;
            name: string;
            description: string;
            color: string;
            emoji?: string;
        }
        | {
            provider: "gemini";
            id: GeminiVoice;
            name: string;
            description: string;
            color: string;
            emoji?: string;
        }
        | {
            provider: "grok";
            id: GrokVoice;
            name: string;
            description: string;
            color: string;
            emoji?: string;
        }
        | {
            provider: "openrouter";
            id: string;
            name: string;
            description: string;
            color: string;
            emoji?: string;
        }
        | {
            provider: "boson";
            id: BosonVoice;
            name: string;
            description: string;
            color: string;
            emoji?: string;
        };

    type ModelProvider = "openai" | "gemini" | "grok" | "elevenlabs" | "hume" | "openrouter" | "boson";

    type BosonVoice =
        | "chloe"
        | "eleanor"
        | "nora"
        | "jake"
        | "marcus"
        | "oliver"
        | "yujin"
        | "jiho";

    type GrokVoice =
        | "Ara"
        | "Eve"
        | "Leo"
        | "Rex"
        | "Sal";

    type GeminiVoice =
        | "Zephyr"
        | "Puck"
        | "Charon"
        | "Kore"
        | "Fenrir"
        | "Leda"
        | "Orus"
        | "Aoede"
        | "Callirrhoe"
        | "Autonoe"
        | "Enceladus"
        | "Iapetus"
        | "Umbriel"
        | "Algieba"
        | "Despina"
        | "Erinome"
        | "Algenib"
        | "Rasalgethi"
        | "Laomedeia"
        | "Achernar"
        | "Alnilam"
        | "Schedar"
        | "Gacrux"
        | "Pulcherrima"
        | "Achird"
        | "Zubenelgenubi"
        | "Vindemiatrix"
        | "Sadachbia"
        | "Sadaltager"
        | "Sulafat";

    type OaiVoice =
        | "ash"
        | "alloy"
        | "echo"
        | "shimmer"
        | "ballad"
        | "coral"
        | "sage"
        | "verse";

    // characters <-> personalities table
    /**
     * oai_voice is for the name of any voice. grok, gemini and openai use this.
     * I forgot to refactor this, please consider updating it for your setup :)
     */
    interface IPersonality {
        personality_id?: string;
        is_doctor: boolean;
        is_child_voice: boolean;
        is_story: boolean;
        key: string;
        oai_voice: string;
        // MiniMax voice id per language_code (en-US, zh-HK, zh-CN). Absent
        // keys keep oai_voice when it can speak that language, otherwise the
        // language default. English stays in oai_voice so older clients that
        // only read that column keep working.
        voices?: Record<string, string>;
        provider: ModelProvider;
        title: string;
        subtitle: string;
        short_description: string;
        character_prompt: string;
        voice_prompt: string;
        first_message_prompt: string;
        creator_id: string | null;
        pitch_factor: number;
        // Public URL of the uploaded artwork. Null means the character has
        // none: a built-in falls back to the bundled /personality image, a
        // user-made one to the emoji derived from its id.
        image_url?: string | null;
        // Retired from the picker without being deleted. The row has to stay:
        // users.personality_id references it, and deleting one silently moves
        // every child using it back to the Elato default.
        is_hidden?: boolean;
        // The IP this character belongs to. Defaults to 'house', our own.
        ip_key?: string;
        // What the character does and its manner, set by its author on the
        // admin page. Null = none: the character prompt alone, as before
        // modes existed. The child can still ask to switch mode mid-session.
        mode_key?: string | null;
        style_key?: string | null;
    }

    type PersonalityFilter = "is_child_voice" | "is_story";

    /** A built-in character, for the admin list. */
    interface IAdminPersonality extends IPersonality {
        personality_id: string;
        created_at?: string;
    }

    type AdminRole = "super_admin" | "content_admin";

    /** A login account as the admin Accounts tab lists it. */
    interface IAccountEntry {
        user_id: string;
        email: string;
        created_at: string;
        last_sign_in_at: string | null;
        confirmed: boolean;
        // Set while GoTrue is refusing sign-in. Null when the account is not banned.
        banned_until: string | null;
    }

    /** One row of admin_audit_log (P1-10). */
    interface IAdminAuditEntry {
        audit_id: number;
        created_at: string;
        actor_id: string | null;
        actor_email: string | null;
        action: string;
        target_table: string | null;
        target_id: string | null;
        target_label: string | null;
        reason: string | null;
        before: Record<string, unknown> | null;
        after: Record<string, unknown> | null;
    }

    /** One board as the admin Devices page lists it (P2-14). No child data. */
    interface IAdminDevice {
        device_id: string;
        mac_address: string | null;
        created_at: string;
        last_seen_at: string | null;
        claimed_at: string | null;
        owner_id: string | null;
        owner_email: string | null;
        firmware_board: string | null;
        firmware_version: string | null;
        firmware_reported_at: string | null;
        ota_failed_version: string | null;
        ota_failed_at: string | null;
        key_issued_at: string | null;
        ip_key: string | null;
    }

    /**
     * One crash report from a board (device_crashes, admin_list_device_crashes()).
     * crash_count is how many crashes since its previous report; the rest
     * describe the last one. pc/ra are null for a brownout.
     */
    interface IAdminDeviceCrash {
        device_id: string | null;
        mac_address: string;
        crash_count: number;
        reason: "panic" | "int_wdt" | "task_wdt" | "wdt" | "brownout";
        firmware_version: string | null;
        pc: string | null;
        ra: string | null;
        uptime_s: number | null;
        task: string | null;
        detail: string | null;
        reported_at: string;
    }

    /** What one board did with one release it was offered (firmware_rollout_devices). */
    interface IAdminRolloutDevice {
        device_id: string;
        mac_address: string | null;
        first_offered_at: string;
        last_offered_at: string;
        offer_count: number;
        running_at: string | null;
        failed_at: string | null;
    }

    /** A firmware release for the admin OTA page, with what the rollout has done so far. */
    interface IAdminFirmwareRelease {
        release_id: string;
        board: string;
        board_label: string;
        version: string;
        size_bytes: number;
        sha256: string;
        notes: string | null;
        created_at: string;
        is_current: boolean;
        rollout_percent: number;
        rollout_macs: string[];
        paused_at: string | null;
        paused_reason: string | null;
        paused_by: string | null;
        stage_changed_at: string | null;
        /** The board's OTA app slot, and the smaller one of boards flashed before P2-12. */
        app_slot: number | null;
        legacy_app_slot: number | null;
        /** Boards of this kind each stage would offer it to, whitelist included. */
        reach: Record<0 | 10 | 50 | 100, number>;
        /** Boards that last reported running this version. */
        running: number;
        rollout: IAdminRolloutDevice[];
    }

    /** STT, TTS and currency rates for pricing usage; LLM prices come from OpenRouter. */
    interface IUsageRates {
        stt_usd_per_hour: number;
        tts_usd_per_million_chars: number;
        usd_to_hkd: number;
    }

    /** Usage summed by the database, per board and model or per day and model. */
    interface IUsageAggregate {
        device_id?: string | null;
        mac_address?: string | null;
        day?: string;
        llm_model: string | null;
        turns: number;
        devices?: number;
        stt_audio_ms: number;
        tts_chars: number;
        prompt_tokens: number;
        completion_tokens: number;
        last_at?: string | null;
    }

    /** One role held by one account, for the super admin's list. */
    interface IAdminRoleEntry {
        user_id: string;
        email: string;
        role: AdminRole;
        granted_by_email: string | null;
        granted_at: string;
        has_totp: boolean;
    }

    type Module = "math" | "science" | "spelling" | "general_trivia";

    type PieChartData = {
        id: string;
        label: string;
        value: number | null;
    };

    interface DataPoint {
        x: string;
        y: number;
    }

    interface HeatMapData {
        id: string;
        data: DataPoint[];
    }

    interface LineChartData {
        id: any;
        name: string;
        data: any;
    }

    interface ProcessedData {
        cardData: CardData | null;
        barData: BarData[];
        lineData: LineData[];
        pieData: PieData[];
        suggestions: string | undefined;
    }

    interface CardData {
        [key: string]: {
            title: string;
            value: number;
            change: number | null;
        };
    }

    interface BarData {
        emotion: string;
        [key: string]: number | string;
    }

    interface LineData {
        id: string;
        name: string;
        data: { x: string; y: number | null }[];
    }

    interface PieData {
        id: string;
        label: string;
        value: number | null;
    }

    interface LastJsonMessageType {
        type: string;
        audio_data: string | null;
        text_data: string | null;
        boundary: string | null;
        task_id: string;
    }

    export interface MessageHistoryType {
        type: string;
        text_data: string | null;
        task_id: string;
    }
}

export {}; // This is necessary to make this file a module and avoid TypeScript errors.
