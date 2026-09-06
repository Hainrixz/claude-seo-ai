import {getSeoMeta} from '@shopify/hydrogen';

export const meta = ({data}) => getSeoMeta(data.seo);
