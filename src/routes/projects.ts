import { Router } from 'express';
import { projects, tasks } from '../services/store';

export const projectsRouter: Router = Router();

projectsRouter.post('/', (req, res) => {
  const name = String(req.body.name ?? '').trim();
  const description = req.body.description ? String(req.body.description) : null;
  if (!name) {
    res.status(400).send('name required');
    return;
  }
  const project = projects.create(name, description);
  res.redirect(`/projects/${project.id}`);
});

projectsRouter.get('/:id', (req, res) => {
  const id = Number(req.params.id);
  const project = projects.get(id);
  if (!project) {
    res.status(404).send('project not found');
    return;
  }
  res.render('project', {
    projects: projects.list(),
    project,
    tasks: tasks.listByProject(id),
    activeTask: null,
  });
});

projectsRouter.post('/:id/delete', (req, res) => {
  projects.remove(Number(req.params.id));
  res.redirect('/');
});
