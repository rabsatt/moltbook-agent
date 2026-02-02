// Supabase Edge Function: Post approved content to Moltbook
// Called from dashboard after approve/edit

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const MOLTBOOK_API = "https://www.moltbook.com/api/v1";

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { draft_id, action, edited_content, edited_title } = await req.json();

    if (!draft_id) {
      throw new Error("draft_id is required");
    }

    if (!["approve", "reject", "edit"].includes(action)) {
      throw new Error("action must be 'approve', 'reject', or 'edit'");
    }

    // Initialize Supabase
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Get draft
    const { data: draft, error: draftError } = await supabase
      .from("post_queue")
      .select("*")
      .eq("id", draft_id)
      .single();

    if (draftError || !draft) {
      throw new Error("Draft not found");
    }

    if (draft.status !== "pending") {
      throw new Error(`Draft already processed (status: ${draft.status})`);
    }

    // Handle rejection
    if (action === "reject") {
      await supabase
        .from("post_queue")
        .update({
          status: "rejected",
          decided_at: new Date().toISOString(),
        })
        .eq("id", draft_id);

      await supabase.from("activity_log").insert({
        action: "rejected",
        post_queue_id: draft_id,
      });

      return new Response(
        JSON.stringify({ success: true, action: "rejected" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Get Moltbook API key
    const { data: config } = await supabase
      .from("agent_config")
      .select("api_key")
      .single();

    if (!config?.api_key) {
      throw new Error("Moltbook API key not configured");
    }

    // Determine final content
    const finalContent = edited_content || draft.content;
    const finalTitle = edited_title || draft.title;
    const wasEdited = !!edited_content || !!edited_title;

    // Post to Moltbook
    let response;
    let moltbookId;

    if (draft.type === "post") {
      response = await fetch(`${MOLTBOOK_API}/posts`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.api_key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          submolt: draft.submolt,
          title: finalTitle,
          content: finalContent,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Moltbook API error: ${response.status} - ${errorText}`);
      }

      const data = await response.json();
      moltbookId = data.id;
    } else {
      // Reply/comment
      response = await fetch(
        `${MOLTBOOK_API}/posts/${draft.reply_to_post_id}/comments`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.api_key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            content: finalContent,
          }),
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Moltbook API error: ${response.status} - ${errorText}`);
      }

      const data = await response.json();
      moltbookId = data.id;
    }

    // Update draft status
    await supabase
      .from("post_queue")
      .update({
        status: wasEdited ? "edited" : "approved",
        final_content: wasEdited ? finalContent : null,
        [draft.type === "post" ? "moltbook_post_id" : "moltbook_comment_id"]: moltbookId,
        decided_at: new Date().toISOString(),
        posted_at: new Date().toISOString(),
      })
      .eq("id", draft_id);

    // Log activity
    await supabase.from("activity_log").insert({
      action: wasEdited ? "edited" : "approved",
      post_queue_id: draft_id,
      details: {
        moltbook_id: moltbookId,
        was_edited: wasEdited,
      },
    });

    return new Response(
      JSON.stringify({
        success: true,
        action: wasEdited ? "edited" : "approved",
        moltbook_id: moltbookId,
        moltbook_url:
          draft.type === "post"
            ? `https://www.moltbook.com/m/${draft.submolt}/${moltbookId}`
            : `https://www.moltbook.com/m/${draft.submolt}/${draft.reply_to_post_id}#${moltbookId}`,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
