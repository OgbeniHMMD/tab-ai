import { useRoutes } from 'react-router-dom';
import routes from '~react-pages';

import { Layout } from './components/Layout';

/**
 * Routes are generated from `src/pages/**` by vite-plugin-pages, then wrapped
 * in the shared `Layout` (header + footer).
 */
export default function App() {
  return useRoutes([{ element: <Layout />, children: routes }]);
}
