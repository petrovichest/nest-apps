import { Link, matchPath, useLocation } from "react-router";
import type { Project } from "@codexnest/protocol";
import { FolderIcon } from "./Icons";

/** Board mode of the navigation: the projects, each opening its board, where its tasks are. */
export function BoardNavigation({
  projects,
  onNavigate,
}: {
  /** In the order of the session list's projects. */
  projects: Project[];
  onNavigate(): void;
}) {
  const location = useLocation();
  const shownProjectId = matchPath("/projects/:projectId/kanban", location.pathname)?.params
    .projectId;

  return (
    <div className="project-list board-navigation">
      {projects.map((project) => {
        const active = project.id === shownProjectId;
        return (
          <Link
            aria-current={active ? "page" : undefined}
            className={`thread-link board-navigation-project${active ? " active" : ""}`}
            key={project.id}
            onClick={onNavigate}
            to={`/projects/${encodeURIComponent(project.id)}/kanban`}
          >
            <FolderIcon />
            <span className="thread-link-title">
              <span className="thread-link-title-text">{project.displayName}</span>
            </span>
          </Link>
        );
      })}
    </div>
  );
}
