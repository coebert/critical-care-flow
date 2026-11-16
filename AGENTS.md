<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

- Internal SECURITY DEFINER maintenance/throttle RPCs are executable by service_role only and called via supabaseAdmin inside server functions; browser flows use src/lib/auth-throttle.functions.ts, which derives principal and success server-side (guarded by src/lib/internal-rpc-callsites.test.ts).
