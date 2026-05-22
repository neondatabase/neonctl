export default function (_req, res) {
  res.json({
    regions: [
      {
        region_id: 'aws-us-east-2',
        name: 'AWS US East (Ohio)',
        default: true,
        geo_lat: '40.0',
        geo_long: '-83.0',
      },
      {
        region_id: 'aws-us-east-1',
        name: 'AWS US East (N. Virginia)',
        default: false,
        geo_lat: '37.5',
        geo_long: '-77.5',
      },
      {
        region_id: 'aws-us-west-2',
        name: 'AWS US West (Oregon)',
        default: false,
        geo_lat: '45.5',
        geo_long: '-122.7',
      },
      {
        region_id: 'aws-eu-central-1',
        name: 'AWS Europe (Frankfurt)',
        default: false,
        geo_lat: '50.1',
        geo_long: '8.7',
      },
    ],
  });
}
