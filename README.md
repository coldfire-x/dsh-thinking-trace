# DSH thinking trace

A minimal DSH plugin for reading the assistant's public task notes and opening related actions in **Trajectory**.

The plugin adds a session view after **Chat** and **Trajectory**. Its English tab is **Decision trace**; its Chinese tab is **思路说明**. Notes are shown in a single column, in chronological order, with small Turn/Step and time labels. Tool inputs, outputs, and execution details stay in Trajectory.

## What it shows

The view displays recorded public assistant explanations and progress updates. It does not expose private internal reasoning, hidden prompts, reasoning blocks, or provider replay state. It does not reconstruct explanations or make extra model calls.

A note can link to a tool call with the same recorded Turn and Step. Selecting **View related actions in Trajectory** loads the corresponding history, opens Trajectory, and focuses the first recorded call in that Step. The association is based on session coordinates, not an inferred causal explanation. Notes without a retained matching call have no action link.

DSH's stored public assistant text does not distinguish progress commentary from final answers, so public final responses can appear here too. Notes appear after the assistant message is committed, rather than token by token.

## Install

Requires a DSH Web profile with conversation views, session projections, and Trajectory enabled. The plugin was developed against DSH `0.2.2-rc.1`.

Clone the source and install its dependencies:

```bash
git clone https://github.com/coldfire-x/dsh-thinking-trace.git
cd dsh-thinking-trace
pnpm install --frozen-lockfile --ignore-scripts
```

In DSH's plugin manager, install this cloned directory as a bundle and enable it. The package identifier is `@local/dsh-decision-trace`. Keep the directory available when using a linked local installation.

Open a conversation, then select **Decision trace** after **Trajectory**. If the header is narrow, DSH may place the tab in **More conversation views**. Refresh the page if the new Client module has not appeared.

If the local development bundle with the same package identifier is already installed, use this checkout as its replacement rather than enabling a second copy.

## Configuration

The bundle declares these Host settings:

| Setting | Default | Range | Meaning |
| --- | --- | --- | --- |
| `maxEntries` | `800` | `100–2000` | Recent projection entries retained per session |
| `maxDetailChars` | `12000` | `1000–24000` | Maximum characters per recorded text preview |

The projection also bounds aggregate retained entry text to 750,000 characters. The page initially displays recent notes; **Show earlier notes** reveals older retained notes. Omitted or shortened history is labeled. Full records remain available through Trajectory's history controls.

Change settings through DSH's configuration editor. Saved projection limits are part of their checkpoints for deterministic replay. Changes to the Host fold or persisted state format require updating `stateVersion`.

## Development

Node.js 22 or later and the pnpm version declared in the package manifest are required. Runtime JavaScript is checked in directly, so no build step or install script is needed.

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm run check
pnpm test
```

The test suite covers public-content selection, concurrent call/result correlation, immutable state, bounded retention, checkpoint replay, exact Turn/Step associations, history-before-navigation ordering, navigation cancellation, and session isolation. Client helper tests do not render or emulate React or the DOM. Browser appearance and actual cross-view interaction should also be checked in a running DSH profile.

The Host derives state from existing session events through `sessionProjections`; it writes no session events. The Client reads that projection through `useProjection`, uses theme tokens and the locale service, and borrows the visible session's existing binding when loading a related action. Switching away during a pending read cancels that navigation.

The public source contains no session transcripts, credentials, local profile files, or machine-specific installation paths. Test content is synthetic. The projection can contain public text and tool previews from a running session; those are not part of the published repository.

## License

MIT. The original plugin icon is included under the same license.
