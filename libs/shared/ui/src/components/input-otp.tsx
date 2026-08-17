'use client';

import * as React from 'react';
import { cn } from '../lib/cn';

export interface InputOTPProps {
  /** Number of digit boxes. Defaults to 6 (a standard TOTP code). */
  length?: number;
  value: string;
  onChange: (value: string) => void;
  /** Fired once every box is filled - the natural place to auto-submit. */
  onComplete?: (value: string) => void;
  disabled?: boolean;
  autoFocus?: boolean;
  invalid?: boolean;
  className?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
}

/**
 * A row of single-digit boxes for entering a TOTP code, with the interaction
 * details (paste-anywhere, backspace-to-previous, arrow-key navigation,
 * digit-only filtering) that make it feel like a native OS one-time-code
 * field rather than N disconnected inputs.
 */
export const InputOTP = React.forwardRef<HTMLDivElement, InputOTPProps>(
  (
    {
      length = 6,
      value,
      onChange,
      onComplete,
      disabled,
      autoFocus,
      invalid,
      className,
      'aria-label': ariaLabel,
      'aria-labelledby': ariaLabelledBy,
    },
    ref,
  ) => {
    const inputsRef = React.useRef<Array<HTMLInputElement | null>>([]);

    const chars = React.useMemo(() => {
      const digits = value.replace(/[^0-9]/g, '').slice(0, length).split('');
      while (digits.length < length) digits.push('');
      return digits;
    }, [value, length]);

    const focusIndex = (index: number) => {
      const el = inputsRef.current[index];
      el?.focus();
      el?.select();
    };

    const commit = (next: string[]) => {
      const joined = next.join('');
      onChange(joined);
      if (joined.length === length && next.every((c) => c !== '')) {
        onComplete?.(joined);
      }
    };

    const applyPaste = (startIndex: number, digits: string) => {
      const next = chars.slice();
      let cursor = startIndex;
      for (const digit of digits) {
        if (cursor >= length) break;
        next[cursor] = digit;
        cursor += 1;
      }
      commit(next);
      focusIndex(Math.min(cursor, length - 1));
    };

    const handleChange = (index: number, raw: string) => {
      const digits = raw.replace(/[^0-9]/g, '');
      if (!digits) {
        const next = chars.slice();
        next[index] = '';
        commit(next);
        return;
      }
      if (digits.length === 1) {
        const next = chars.slice();
        next[index] = digits;
        commit(next);
        if (index < length - 1) focusIndex(index + 1);
        return;
      }
      // A multi-character value in one box means the OS delivered a paste
      // (or autofill) through onChange instead of a paste event.
      applyPaste(index, digits);
    };

    const handleKeyDown = (index: number, event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Backspace') {
        event.preventDefault();
        const next = chars.slice();
        if (next[index]) {
          next[index] = '';
          commit(next);
        } else if (index > 0) {
          next[index - 1] = '';
          commit(next);
          focusIndex(index - 1);
        }
      } else if (event.key === 'ArrowLeft' && index > 0) {
        event.preventDefault();
        focusIndex(index - 1);
      } else if (event.key === 'ArrowRight' && index < length - 1) {
        event.preventDefault();
        focusIndex(index + 1);
      }
    };

    const handlePaste = (index: number, event: React.ClipboardEvent<HTMLInputElement>) => {
      const digits = event.clipboardData.getData('text').replace(/[^0-9]/g, '');
      if (!digits) return;
      event.preventDefault();
      applyPaste(index, digits);
    };

    return (
      <div ref={ref} role="group" aria-label={ariaLabel} aria-labelledby={ariaLabelledBy} className="flex gap-2">
        {chars.map((char, index) => (
          <input
            key={index}
            ref={(el) => {
              inputsRef.current[index] = el;
            }}
            type="text"
            inputMode="numeric"
            autoComplete={index === 0 ? 'one-time-code' : 'off'}
            pattern="[0-9]*"
            maxLength={1}
            value={char}
            disabled={disabled}
            autoFocus={autoFocus && index === 0}
            aria-invalid={invalid || undefined}
            aria-label={ariaLabel || ariaLabelledBy ? `Digit ${index + 1} of ${length}` : undefined}
            onChange={(event) => handleChange(index, event.target.value)}
            onKeyDown={(event) => handleKeyDown(index, event)}
            onPaste={(event) => handlePaste(index, event)}
            onFocus={(event) => event.target.select()}
            className={cn(
              'h-11 w-9 rounded-control border border-border-strong bg-surface text-center text-lg font-semibold text-fg',
              'transition-colors duration-150 ease-out motion-reduce:transition-none',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
              'disabled:cursor-not-allowed disabled:opacity-50',
              invalid && 'border-danger',
              className,
            )}
          />
        ))}
      </div>
    );
  },
);
InputOTP.displayName = 'InputOTP';
