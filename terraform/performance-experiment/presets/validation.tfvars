# 검증용 preset (실제 실험 구성 ID와 capacity 값은 성능 환경 확보 후 별도 preset으로 정의합니다).
# 구성 ID(infrastructure_id)는 파일 이름에서 정해지며 진입점이 -var로 전달합니다.
# 실행 시 infrastructure_revision, app_image_tag, demo_ai_* 등 실행별 입력을 함께 전달합니다.
performance_api_cpu                       = 512
performance_api_memory                    = 1024
performance_api_desired_count             = 1
performance_worker_cpu                    = 512
performance_worker_memory                 = 1024
performance_worker_desired_count          = 1
performance_worker_work_items_concurrency = 1
performance_sagemaker_instance_type       = "ml.g5.xlarge"
performance_sagemaker_instance_count      = 1
expected_performance_rds_instance_class   = "db.t4g.micro"
