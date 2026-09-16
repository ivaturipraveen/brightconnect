# Clear Button Manual Test Guide

## Setup
1. The dev server is running on http://localhost:5174/app/
2. Open the app in your browser
3. Use the browser's developer tools console to run automated tests, or follow the manual steps below

## Test Cases

### Test 1: Button Visibility - Initial State
**Expected:** Clear button is NOT visible when the input textarea is empty

**Steps:**
1. Load the app
2. Look at the input area at the bottom
3. Verify that there is NO button with an X icon between the textarea and the Send button

**Result:** ✓ PASS / ✗ FAIL

---

### Test 2: Button Visibility - After Typing
**Expected:** Clear button appears when you type text in the input

**Steps:**
1. Click in the textarea input field
2. Type some text (e.g., "Hello world")
3. Look for the clear button between the textarea and the Send button
4. Verify an X icon appears in a small rounded button

**Result:** ✓ PASS / ✗ FAIL

---

### Test 3: Button Functionality - Clears Input
**Expected:** Clicking the clear button removes all text from the input

**Steps:**
1. Type some text in the textarea (e.g., "Test message")
2. Click the clear button (the X icon)
3. Verify the textarea is now empty
4. Verify the clear button disappears

**Result:** ✓ PASS / ✗ FAIL

---

### Test 4: Focus Handling - Focus Returns to Input
**Expected:** After clicking the clear button, focus returns to the textarea so you can continue typing immediately

**Steps:**
1. Type some text in the textarea
2. Click the clear button
3. Without clicking anywhere else, start typing immediately
4. Verify that the text you type goes into the textarea (not somewhere else)
5. Verify that the cursor is visible in the textarea

**Result:** ✓ PASS / ✗ FAIL

---

### Test 5: Layout Stability - No Jumping
**Expected:** The appearance and disappearance of the clear button does not cause layout shifts

**Steps:**
1. Type slowly and watch the button area
2. Clear the text slowly and watch the button area
3. Note if any visual "jumping" or shifting occurs as the button appears/disappears
4. Check if the buttons stay aligned vertically

**Visual Inspection:**
- No horizontal shifting of other buttons
- No vertical alignment changes
- Smooth appearance/disappearance transition

**Result:** ✓ PASS / ✗ FAIL

---

### Test 6: Streaming State - Button Hidden During Streaming
**Expected:** The clear button is hidden while the assistant is responding (streaming). Only the Stop button should show.

**Steps:**
1. Type a question (e.g., "What is 2+2?")
2. Press Enter or click the Send button
3. As soon as the assistant starts responding:
   - Verify the clear button is NO LONGER visible
   - Verify the STOP button (square icon) appears instead
4. Wait for the response to complete
5. Verify the Send button appears again

**Result:** ✓ PASS / ✗ FAIL

---

### Test 7: Light/Dark Theme - Button Readable in Both Themes
**Expected:** The clear button is readable and styled correctly in both light and dark color schemes

**Steps:**
1. Check the current theme of your system/browser
2. Look at the clear button styling:
   - Button should have a subtle background color (raised)
   - Button should have a darker/lighter text color depending on theme
   - Hover effect should be visible when you hover over the button
3. If your system has a theme switcher (not visible in current app), switch themes and repeat

**Visual Inspection:**
- Clear button is readable in current theme
- Text color has sufficient contrast
- Hover state is clearly visible
- No white-on-white or black-on-black issues

**Result:** ✓ PASS / ✗ FAIL

---

### Test 8: Styling Consistency - Matches Stop/Send Buttons
**Expected:** The clear button has the same visual style as the Stop and Send buttons

**Steps:**
1. Trigger streaming by sending a question
2. While streaming, compare the clear button's would-be position with the visible Stop button:
   - Same size (8px × 8px with padding)
   - Same border radius (rounded corners)
   - Same padding/spacing
3. Clear the input to show the Send button
4. Compare the clear button with the Send button:
   - Same size
   - Same border radius
   - Same spacing around buttons
   - Same transition effects on hover

**Visual Inspection:**
- Clear button dimensions: ~32px × 32px (with h-8 w-8 classes)
- All buttons are aligned vertically at the bottom
- All buttons have rounded-lg styling
- All buttons have smooth hover transitions

**Result:** ✓ PASS / ✗ FAIL

---

### Test 9: Whitespace Handling - Only Spaces Don't Show Clear
**Expected:** The clear button should not appear if the input contains only whitespace

**Steps:**
1. Click in the textarea
2. Type only spaces (no actual text)
3. Verify the clear button does NOT appear
4. Type spaces and then a newline character
5. Verify the clear button still does NOT appear

**Result:** ✓ PASS / ✗ FAIL

---

### Test 10: Multiple Clear Operations
**Expected:** You can click the clear button multiple times if you type new text after clearing

**Steps:**
1. Type "First message"
2. Click the clear button
3. Type "Second message"
4. Click the clear button again
5. Type "Third message"
6. Click the clear button a third time
7. Verify the textarea is empty and clear button is hidden

**Result:** ✓ PASS / ✗ FAIL

---

## Automated Test Runner (Browser Console)

To run automated tests in your browser:

1. Open the developer tools console (F12 or Cmd+Option+I)
2. Copy and paste the test code from `tests/clear-button.test.ts`
3. Run: `runClearButtonTests()`
4. Review the test results in the console

---

## Summary

Once you've run through all test cases, fill in the results:

| Test Case | Result |
|-----------|--------|
| 1. Initial visibility (empty) | ✓ / ✗ |
| 2. Visibility after typing | ✓ / ✗ |
| 3. Clears input functionality | ✓ / ✗ |
| 4. Focus returns to input | ✓ / ✗ |
| 5. Layout stability | ✓ / ✗ |
| 6. Hidden during streaming | ✓ / ✗ |
| 7. Light/dark theme | ✓ / ✗ |
| 8. Styling consistency | ✓ / ✗ |
| 9. Whitespace handling | ✓ / ✗ |
| 10. Multiple clear operations | ✓ / ✗ |

---

## Additional Notes

- The clear button uses an X icon (SVG stroke)
- It appears between the textarea and the Send/Stop button
- It has hover styling with a slightly darker background
- It maintains vertical alignment with other action buttons
- The button is a child of the input container flex layout
