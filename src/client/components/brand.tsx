import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";

export function Brand({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation();

  return (
    <Link className="brand" to="/" aria-label={t("AgentFlowing home")}>
      <span className="brand-mark" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      {!compact && <span>AgentFlowing</span>}
    </Link>
  );
}
