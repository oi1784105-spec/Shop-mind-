import { useContext } from 'react';
import { Navigate, Outlet } from 'react-router';

import { Routes } from '@/routes';
import authorizationUtil from '@/utils/authorization-util';
import { CurrentUserInfoContext } from './root-layout';
import { isAdminOpsHost } from '../utils';

export default function AdminAuthorizedLayout() {
  const [{ userInfo }] = useContext(CurrentUserInfoContext);
  const isLoggedIn =
    isAdminOpsHost() || (!!authorizationUtil.getAuthorization() && !!userInfo);

  return isLoggedIn ? <Outlet /> : <Navigate to={Routes.Admin} />;
}
