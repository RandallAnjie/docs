import { Check, FileText } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';

import type {
  JsonValue,
  PublicDatabaseFormDefinition,
  PublicDatabaseFormField,
} from '@rdocs/shared';

import { getPublicDatabaseForm, submitPublicDatabaseForm } from './api';
import { formFieldVisible } from './form-logic';

function options(field: PublicDatabaseFormField): string[] {
  return Array.isArray(field.config.options)
    ? field.config.options.filter((option): option is string => typeof option === 'string')
    : [];
}

function inputType(field: PublicDatabaseFormField): string {
  if (field.type === 'number') return 'number';
  if (field.type === 'date') return 'date';
  if (field.type === 'email') return 'email';
  if (field.type === 'url') return 'url';
  if (field.type === 'phone') return 'tel';
  return 'text';
}

export function PublicDatabaseForm({ token }: { token: string }) {
  const [form, setForm] = useState<PublicDatabaseFormDefinition | null>(null);
  const [values, setValues] = useState<Record<string, JsonValue>>({});
  const [loadingError, setLoadingError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    getPublicDatabaseForm(token)
      .then(({ form: definition }) => active && setForm(definition))
      .catch(
        (reason: unknown) =>
          active && setLoadingError(reason instanceof Error ? reason.message : '无法打开表单'),
      );
    return () => {
      active = false;
    };
  }, [token]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!form || busy) return;
    setBusy(true);
    setSubmitError(null);
    try {
      const result = await submitPublicDatabaseForm(token, values);
      setSuccess(result.message);
      setValues({});
    } catch (reason) {
      setSubmitError(reason instanceof Error ? reason.message : '提交失败，请重试');
    } finally {
      setBusy(false);
    }
  };

  if (loadingError) {
    return (
      <main className="public-form-shell">
        <section className="public-form-card public-form-state">
          <FileText size={28} />
          <h1>无法打开表单</h1>
          <p>{loadingError}</p>
        </section>
      </main>
    );
  }
  if (!form) {
    return (
      <main className="public-form-shell">
        <section className="public-form-card public-form-state">
          <p>正在打开表单…</p>
        </section>
      </main>
    );
  }
  if (success) {
    return (
      <main className="public-form-shell">
        <section className="public-form-card public-form-state">
          <span className="public-form-success-icon">
            <Check size={28} />
          </span>
          <h1>{success}</h1>
          <button type="button" onClick={() => setSuccess(null)}>
            再提交一份
          </button>
        </section>
      </main>
    );
  }
  return (
    <main className="public-form-shell">
      <form className="public-form-card" onSubmit={(event) => void submit(event)}>
        <a className="public-form-brand" href="/">
          <span>R</span> Rdocs
        </a>
        <header>
          <h1>{form.title}</h1>
          {form.description ? <p>{form.description}</p> : null}
        </header>
        {form.fields.map((field) => {
          if (!formFieldVisible(field, values)) return null;
          const fieldOptions = options(field);
          const fieldValue = values[field.id];
          return (
            <fieldset key={field.id}>
              <legend>
                {field.name} {field.required ? <b>*</b> : null}
              </legend>
              {field.type === 'checkbox' ? (
                <label className="public-form-checkbox">
                  <input
                    type="checkbox"
                    checked={fieldValue === true}
                    onChange={(event) =>
                      setValues((current) => ({ ...current, [field.id]: event.target.checked }))
                    }
                  />
                  <span>是</span>
                </label>
              ) : field.type === 'select' || field.type === 'status' ? (
                <select
                  required={field.required}
                  value={typeof fieldValue === 'string' ? fieldValue : ''}
                  onChange={(event) =>
                    setValues((current) => ({ ...current, [field.id]: event.target.value }))
                  }
                >
                  <option value="">请选择</option>
                  {fieldOptions.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              ) : field.type === 'multi_select' ? (
                <div className="public-form-options">
                  {fieldOptions.map((option) => {
                    const selected = Array.isArray(fieldValue)
                      ? fieldValue.filter((value): value is string => typeof value === 'string')
                      : [];
                    return (
                      <label key={option}>
                        <input
                          type="checkbox"
                          checked={selected.includes(option)}
                          onChange={(event) =>
                            setValues((current) => ({
                              ...current,
                              [field.id]: event.target.checked
                                ? [...selected, option]
                                : selected.filter((value) => value !== option),
                            }))
                          }
                        />
                        <span>{option}</span>
                      </label>
                    );
                  })}
                </div>
              ) : field.type === 'text' ? (
                <textarea
                  required={field.required}
                  value={typeof fieldValue === 'string' ? fieldValue : ''}
                  onChange={(event) =>
                    setValues((current) => ({ ...current, [field.id]: event.target.value }))
                  }
                />
              ) : (
                <input
                  type={inputType(field)}
                  required={field.required}
                  value={
                    typeof fieldValue === 'string' || typeof fieldValue === 'number'
                      ? fieldValue
                      : ''
                  }
                  onChange={(event) =>
                    setValues((current) => ({
                      ...current,
                      [field.id]:
                        field.type === 'number'
                          ? event.target.value
                            ? Number(event.target.value)
                            : null
                          : event.target.value,
                    }))
                  }
                />
              )}
            </fieldset>
          );
        })}
        {submitError ? (
          <p className="public-form-error" role="alert">
            {submitError}
          </p>
        ) : null}
        <button className="public-form-submit" type="submit" disabled={busy}>
          {busy ? '正在提交…' : form.submitLabel}
        </button>
        <footer>由 Rdocs 安全收集 · 提交者不会获得数据库访问权</footer>
      </form>
    </main>
  );
}
