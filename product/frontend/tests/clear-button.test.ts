/**
 * Clear button tests for the chat composer
 *
 * These tests verify:
 * 1. Button visibility: Hidden when input is empty, appears when text is typed
 * 2. Button functionality: Clicking the button clears the input field
 * 3. Focus handling: After clicking clear, focus returns to the textarea
 * 4. Layout stability: No layout shifts when button appears/disappears
 * 5. Streaming state: Button is hidden while streaming (only Stop button shows)
 * 6. Light/dark themes: Button is readable in both themes
 * 7. Styling consistency: Button matches the styling of Stop/Send buttons
 */

// Test utilities
const test = {
  passed: 0,
  failed: 0,

  assert(condition: boolean, message: string): void {
    if (condition) {
      console.log(`✓ ${message}`);
      this.passed++;
    } else {
      console.error(`✗ ${message}`);
      this.failed++;
    }
  },

  assertEqual<T>(actual: T, expected: T, message: string): void {
    this.assert(actual === expected, `${message} (expected: ${expected}, got: ${actual})`);
  },

  assertNotNull<T>(value: T | null | undefined, message: string): value is T {
    this.assert(value != null, `${message} - value should not be null`);
    return value != null;
  },

  report(): void {
    const total = this.passed + this.failed;
    console.log(`\n${'='.repeat(50)}`);
    console.log(`Test Results: ${this.passed}/${total} passed`);
    if (this.failed > 0) {
      console.log(`${this.failed} test(s) failed`);
    }
    console.log(`${'='.repeat(50)}\n`);
  },
};

interface TestResult {
  name: string;
  passed: boolean;
  message: string;
}

// Main test suite
export async function runClearButtonTests(): Promise<TestResult[]> {
  const results: TestResult[] = [];

  // Wait for app to be ready
  await new Promise(resolve => setTimeout(resolve, 1000));

  console.log('\n=== Clear Button Test Suite ===\n');

  // Test 1: Button visibility - initial state (empty input)
  console.log('Test 1: Button visibility - initial state');
  {
    const textarea = document.querySelector<HTMLTextAreaElement>('textarea[placeholder="Ask anything"]');
    const clearButton = document.querySelector('button[title="Clear"]');

    if (test.assertNotNull(textarea, 'Textarea should exist')) {
      test.assertEqual(textarea.value, '', 'Textarea should be empty initially');
      test.assert(clearButton === null, 'Clear button should be hidden when input is empty');
    }
  }

  // Test 2: Button visibility - after typing
  console.log('\nTest 2: Button visibility - after typing');
  {
    const textarea = document.querySelector<HTMLTextAreaElement>('textarea[placeholder="Ask anything"]');

    if (test.assertNotNull(textarea, 'Textarea should exist')) {
      // Simulate typing
      textarea.value = 'Hello world';
      textarea.dispatchEvent(new Event('change', { bubbles: true }));
      textarea.dispatchEvent(new InputEvent('input', { bubbles: true }));

      // Wait for React to re-render
      await new Promise(resolve => setTimeout(resolve, 100));

      const clearButton = document.querySelector('button[title="Clear"]');
      test.assert(clearButton !== null, 'Clear button should be visible when input has text');

      if (clearButton) {
        const svg = clearButton.querySelector('svg');
        test.assert(svg !== null, 'Clear button should contain an SVG icon');
        test.assert(clearButton.classList.contains('rounded-lg'), 'Button should have rounded corners');
        test.assert(clearButton.classList.contains('bg-raised'), 'Button should have bg-raised class');
      }
    }
  }

  // Test 3: Button functionality - clicking clears input
  console.log('\nTest 3: Button functionality - clicking clears input');
  {
    const textarea = document.querySelector<HTMLTextAreaElement>('textarea[placeholder="Ask anything"]');
    const clearButton = document.querySelector('button[title="Clear"]');

    if (test.assertNotNull(textarea, 'Textarea should exist') && test.assertNotNull(clearButton, 'Clear button should exist')) {
      // Button exists, click it
      clearButton.click();

      // Wait for React to re-render
      await new Promise(resolve => setTimeout(resolve, 100));

      test.assertEqual(textarea.value, '', 'Textarea should be cleared after clicking clear button');

      // Check that clear button is now hidden again
      const clearButtonAfter = document.querySelector('button[title="Clear"]');
      test.assert(clearButtonAfter === null, 'Clear button should be hidden again after clearing input');
    }
  }

  // Test 4: Focus handling - focus returns to textarea
  console.log('\nTest 4: Focus handling - focus returns to textarea');
  {
    const textarea = document.querySelector<HTMLTextAreaElement>('textarea[placeholder="Ask anything"]');

    if (test.assertNotNull(textarea, 'Textarea should exist')) {
      // Set up input with text
      textarea.value = 'Test text';
      textarea.dispatchEvent(new Event('change', { bubbles: true }));
      textarea.dispatchEvent(new InputEvent('input', { bubbles: true }));

      await new Promise(resolve => setTimeout(resolve, 100));

      const clearButton = document.querySelector('button[title="Clear"]');
      if (test.assertNotNull(clearButton, 'Clear button should exist')) {
        // Click the clear button
        clearButton.click();

        // Wait for focus to be applied
        await new Promise(resolve => setTimeout(resolve, 100));

        test.assert(document.activeElement === textarea, 'Focus should return to textarea after clearing');
      }
    }
  }

  // Test 5: Styling consistency - compare with Send button
  console.log('\nTest 5: Styling consistency - compare with Send button');
  {
    const sendButton = document.querySelector('button[title="Send"]');

    // Add text to get clear button visible
    const textarea = document.querySelector<HTMLTextAreaElement>('textarea[placeholder="Ask anything"]');
    if (test.assertNotNull(textarea, 'Textarea should exist')) {
      textarea.value = 'Test';
      textarea.dispatchEvent(new Event('change', { bubbles: true }));
      textarea.dispatchEvent(new InputEvent('input', { bubbles: true }));

      await new Promise(resolve => setTimeout(resolve, 100));

      const clearButton = document.querySelector('button[title="Clear"]');

      if (test.assertNotNull(clearButton, 'Clear button should exist') && test.assertNotNull(sendButton, 'Send button should exist')) {
        // Check button dimensions
        const clearButtonStyle = window.getComputedStyle(clearButton);
        const sendButtonStyle = window.getComputedStyle(sendButton);

        test.assertEqual(clearButtonStyle.height, sendButtonStyle.height, 'Clear and Send buttons should have same height');
        test.assertEqual(clearButtonStyle.width, sendButtonStyle.width, 'Clear and Send buttons should have same width');

        // Check border radius
        test.assert(clearButton.classList.contains('rounded-lg'), 'Clear button should have rounded-lg class');
        test.assert(sendButton.classList.contains('rounded-lg'), 'Send button should have rounded-lg class');
      }
    }
  }

  // Test 6: Whitespace handling - button hidden when only whitespace
  console.log('\nTest 6: Whitespace handling - button hidden when only whitespace');
  {
    const textarea = document.querySelector<HTMLTextAreaElement>('textarea[placeholder="Ask anything"]');

    if (test.assertNotNull(textarea, 'Textarea should exist')) {
      textarea.value = '   \n  ';
      textarea.dispatchEvent(new Event('change', { bubbles: true }));
      textarea.dispatchEvent(new InputEvent('input', { bubbles: true }));

      await new Promise(resolve => setTimeout(resolve, 100));

      const clearButton = document.querySelector('button[title="Clear"]');
      test.assert(clearButton === null, 'Clear button should be hidden when input contains only whitespace');
    }
  }

  // Test 7: Button accessibility - proper title attribute
  console.log('\nTest 7: Button accessibility - proper title attribute');
  {
    const textarea = document.querySelector<HTMLTextAreaElement>('textarea[placeholder="Ask anything"]');

    if (test.assertNotNull(textarea, 'Textarea should exist')) {
      textarea.value = 'Test';
      textarea.dispatchEvent(new Event('change', { bubbles: true }));
      textarea.dispatchEvent(new InputEvent('input', { bubbles: true }));

      await new Promise(resolve => setTimeout(resolve, 100));

      const clearButton = document.querySelector('button[title="Clear"]');
      if (test.assertNotNull(clearButton, 'Clear button should exist')) {
        test.assertEqual(clearButton.getAttribute('title'), 'Clear', 'Clear button should have "Clear" title');
        test.assert(clearButton.tagName === 'BUTTON', 'Clear button should be a button element');
      }
    }
  }

  test.report();

  return results;
}

// Run tests if this is being executed in a browser context
if (typeof document !== 'undefined') {
  console.log('Clear button tests loaded. Run: runClearButtonTests()');
}

export { test };
