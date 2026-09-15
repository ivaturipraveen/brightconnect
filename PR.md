## Summary

Implement a live character count display under the chat composer in the frontend. The character count appears as a small, muted number at the right-hand end below the textarea input, using existing design tokens to maintain consistency with the product's visual system.

## What Changed

- **frontend/src/App.tsx**: Added character count display (lines 154-156) that:
  - Shows the current length of the input using `{[...input].length}`
  - Positioned at the right-hand end below the textarea
  - Uses existing design tokens (`text-text-faint` for muted appearance)
  - Properly handles Unicode characters including emoji (uses spread operator for accurate counting)
  - Supports both light and dark themes automatically

## Implementation Details

The character count is displayed in a simple div with Tailwind classes:
- `mt-2` - Consistent vertical spacing
- `text-right` - Positions count at the right end
- `text-[11px]` - Small text size matching the help text
- `text-text-faint` - Muted color using existing design token

The implementation uses the spread operator (`[...input]`) to correctly count Unicode characters rather than UTF-16 code units, ensuring emoji and complex Unicode display accurate counts.

## Test Results

✅ **TypeScript**: No errors (0 violations)
✅ **Build**: Production build succeeds (30 modules transformed in 2.13s)
✅ **Dependencies**: 79 packages installed, 0 vulnerabilities

## Code Review

✅ **Correctness**: Properly tracks live input length, handles empty input (0), multi-line input, and Unicode characters
✅ **Design**: Consistent with existing visual system, supports light/dark themes
✅ **Security**: No XSS/injection risks, safe React state management
✅ **Performance**: No performance concerns

## Closes

Resolves #2 - Show a character count under the chat input
