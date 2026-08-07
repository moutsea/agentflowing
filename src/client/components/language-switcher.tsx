import { Languages } from "lucide-react";
import { useTranslation } from "react-i18next";

export function LanguageSwitcher({ className = "" }: { className?: string }) {
  const { i18n, t } = useTranslation();
  const language = i18n.resolvedLanguage?.startsWith("zh") ? "zh-CN" : "en";

  return (
    <label className={`language-switcher ${className}`.trim()}>
      <Languages size={15} />
      <span className="sr-only">{t("Language")}</span>
      <select
        aria-label={t("Language")}
        onChange={(event) => void i18n.changeLanguage(event.target.value)}
        value={language}
      >
        <option value="en">{t("English")}</option>
        <option value="zh-CN">{t("Chinese")}</option>
      </select>
    </label>
  );
}
