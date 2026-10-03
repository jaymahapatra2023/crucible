import { forwardRef, type ReactNode } from 'react'

/**
 * A labelled form control (P5.5).
 *
 * The label is a real `<label>` bound by id, and the hint is bound by `aria-describedby`, so a
 * screen reader announces what the field is for at the moment it receives focus rather than
 * leaving the user to hunt for grey text above it.
 */
export function FormField({
  id, label, hint, required, error, children,
}: {
  id: string
  label: string
  hint?: string
  required?: boolean
  error?: string | null
  children: ReactNode
}) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label htmlFor={id} style={{ display: 'block', fontWeight: 600, marginBottom: 4 }}>
        {label}
        {required && <span aria-hidden="true" style={{ color: 'var(--danger)' }}> *</span>}
        {required && <span className="sr-only"> (required)</span>}
      </label>
      {hint && (
        <p id={`${id}-hint`} style={{ margin: '0 0 6px', color: 'var(--text-muted)', fontSize: 13 }}>
          {hint}
        </p>
      )}
      {children}
      {error && (
        <p id={`${id}-error`} role="alert" style={{ margin: '4px 0 0', color: 'var(--danger)' }}>
          {error}
        </p>
      )}
    </div>
  )
}

const CONTROL: React.CSSProperties = {
  width: '100%', padding: '6px 8px', font: 'inherit',
  border: '1px solid var(--border)', borderRadius: 6, background: 'var(--surface)',
  color: 'var(--text)',
}

/**
 * Forwards its ref (E44): the team builder returns focus to the teammate box after each add, and
 * a function component silently drops a `ref` it does not forward.
 */
export const TextInput = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function TextInput(props, ref) {
    return <input ref={ref} {...props} style={{ ...CONTROL, ...props.style }} />
  },
)

export function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} style={{ ...CONTROL, minHeight: 72, resize: 'vertical', ...props.style }} />
}

export function Select({ options, ...props }: React.SelectHTMLAttributes<HTMLSelectElement> & {
  options: readonly string[]
}) {
  return (
    <select {...props} style={{ ...CONTROL, ...props.style }}>
      {options.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  )
}

/** A comma-separated list, edited as text. Kept deliberately plain: it is a list of short tags. */
export function TagInput({
  id, value, onChange, placeholder,
}: {
  id: string
  value: string[]
  onChange: (next: string[]) => void
  placeholder?: string
}) {
  return (
    <TextInput
      id={id}
      value={value.join(', ')}
      placeholder={placeholder ?? 'comma, separated'}
      onChange={(e) => onChange(
        e.target.value.split(',').map((s) => s.trim()).filter((s) => s.length > 0))}
    />
  )
}
