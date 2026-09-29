export function createProjectsService() {
  return {
    async listProjects() {
      return [{
        id: 'project-1',
        name: 'Launch plan'
      }];
    },
    async refreshIndex({ projectId }) {
      return {
        indexed: projectId === 'project-1'
      };
    }
  };
}
